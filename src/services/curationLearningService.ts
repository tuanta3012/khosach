import { getApps, getApp, initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { BookRecord, ConsensusRule, RuleType } from '../types';
import { canonicalizeVolume, removeVietnameseTones } from '../utils/fuzzyMatcher';
import { saveMasterSyncStateToGoogleSheet, readMasterSyncStateFromGoogleSheet } from './driveSyncService';

// Khởi tạo an toàn Firebase Firestore
const getFirebaseApp = () => (getApps().length > 0 ? getApp() : initializeApp(firebaseConfig));
const db = getFirestore(getFirebaseApp());

export const LEARNED_RULES_STORAGE_KEY = 'library_learned_rules_v1';
export const CLOUD_COMMUNITY_DOC_PATH = 'community_knowledge/consensus_rules_v1';

// Cờ phiên trong bộ nhớ: Chỉ check Cloud đúng 1 lần duy nhất khi khởi động ứng dụng
let hasCheckedCloudRulesThisSession = false;

// Hàng đợi delta quy tắc chờ gửi Cloud Firestore khi kết thúc toàn bộ quy trình
const pendingSessionRuleVotes: Map<string, { rule: ConsensusRule; voteDelta: number }> = new Map();

/**
 * Bộ quy tắc cốt lõi mặc định đã kiểm định cho sách tiếng Việt (Baseline Rules)
 * Đảm bảo ứng dụng thông minh ngay từ lần đầu mở máy kể cả khi chưa có mạng.
 */
export const DEFAULT_BASELINE_RULES: ConsensusRule[] = [
  {
    id: 'rule_author_prefix_strip',
    type: 'AUTHOR_PREFIX_STRIP',
    title: 'Xóa danh xưng học hàm trước tên tác giả',
    description: 'Tự động lược bỏ các tiền tố học hàm như BS., ThS., TS., GS., Bác sĩ, Thạc sĩ trước tên tác giả',
    targetField: 'author',
    pattern: '^(BS\\.|ThS\\.|TS\\.|GS\\.|Bác sĩ|Thạc sĩ|Tiến sĩ|Giáo sư)\\s+',
    action: 'STRIP',
    source: 'COMMUNITY',
    voteCount: 150,
    confidenceRate: 0.98,
    updatedAt: 1740000000000,
  },
  {
    id: 'rule_author_editorial_strip',
    type: 'AUTHOR_EDITORIAL_STRIP',
    title: 'Xóa vai trò phụ chú biên soạn sau tên tác giả',
    description: 'Xóa phần phụ chú trong ngoặc đơn như (Chủ biên), (Biên dịch), (Dịch giả) ở cuối tên tác giả',
    targetField: 'author',
    pattern: '\\s*\\((chủ biên|biên dịch|dịch giả|tuyển chọn|cb)\\)$',
    action: 'STRIP',
    source: 'COMMUNITY',
    voteCount: 120,
    confidenceRate: 0.95,
    updatedAt: 1740000000000,
  },
  {
    id: 'rule_volume_disambiguation',
    type: 'VOLUME_DISAMBIGUATION',
    title: 'Phân biệt các tập độc lập của cùng bộ sách',
    description: 'Hai cuốn sách có cùng tựa đề gốc nhưng khác số tập (Tập 1, Tập 2, Vol 1, Vol 2) là tác phẩm riêng biệt, không gộp trùng',
    targetField: 'pair',
    pattern: 'SAME_TITLE_DIFFERENT_VOLUME',
    action: 'MARK_DISTINCT',
    source: 'COMMUNITY',
    voteCount: 200,
    confidenceRate: 0.99,
    updatedAt: 1740000000000,
  },
  {
    id: 'rule_subtitle_preserve',
    type: 'SUBTITLE_PRESERVE',
    title: 'Bảo toàn phụ đề sau dấu hai chấm',
    description: 'Giữ nguyên phần phụ đề sau dấu hai chấm (:) hoặc gạch nối (-) khi chuẩn hóa tiêu đề sách',
    targetField: 'title',
    pattern: ':\\s*.+',
    action: 'PRESERVE',
    source: 'COMMUNITY',
    voteCount: 95,
    confidenceRate: 0.92,
    updatedAt: 1740000000000,
  },
  {
    id: 'rule_cat_keyword_kinhte',
    type: 'CATEGORY_KEYWORD_MAP',
    title: 'Nhận diện sách Kinh tế qua từ khóa tiêu đề',
    description: 'Gán thể loại Kinh Tế khi tiêu đề chứa từ khóa kinh tế, đầu tư, chứng khoán, tài chính, doanh nghiệp',
    targetField: 'category',
    pattern: '(kinh tế|đầu tư|chứng khoán|tài chính|doanh nghiệp|maketing|marketing)',
    action: 'SET_CATEGORY',
    value: 'Kinh Tế',
    source: 'COMMUNITY',
    voteCount: 88,
    confidenceRate: 0.91,
    updatedAt: 1740000000000,
  },
  {
    id: 'rule_cat_keyword_trinhtham',
    type: 'CATEGORY_KEYWORD_MAP',
    title: 'Nhận diện sách Trinh thám qua từ khóa tiêu đề',
    description: 'Gán thể loại Trinh thám khi tiêu đề chứa từ khóa trinh thám, vụ án, phá án, conan, holmes, sát nhân',
    targetField: 'category',
    pattern: '(trinh thám|vụ án|phá án|conan|holmes|sát nhân|kẻ sát nhân|thám tử)',
    action: 'SET_CATEGORY',
    value: 'Văn học - Trinh thám',
    source: 'COMMUNITY',
    voteCount: 85,
    confidenceRate: 0.93,
    updatedAt: 1740000000000,
  },
];

/**
 * Đọc toàn bộ danh sách quy tắc đang có hiệu lực (LocalStorage + Baseline Rules)
 */
export function getActiveLearnedRules(): ConsensusRule[] {
  try {
    const raw = localStorage.getItem(LEARNED_RULES_STORAGE_KEY);
    let stored: ConsensusRule[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        stored = parsed;
      }
    }

    const map = new Map<string, ConsensusRule>();
    // Nạp baseline rules trước
    for (const r of DEFAULT_BASELINE_RULES) {
      map.set(r.id, r);
    }
    // Ghi đè hoặc bổ sung từ storage
    for (const r of stored) {
      if (r && r.id) {
        map.set(r.id, r);
      }
    }

    return Array.from(map.values()).sort((a, b) => b.voteCount - a.voteCount);
  } catch {
    return [...DEFAULT_BASELINE_RULES];
  }
}

/**
 * Lưu danh sách quy tắc vào LocalStorage
 */
export function saveLearnedRulesLocally(rules: ConsensusRule[]): void {
  try {
    localStorage.setItem(LEARNED_RULES_STORAGE_KEY, JSON.stringify(rules));
  } catch (err) {
    console.warn('[CurationLearning] Lỗi lưu rules vào localStorage:', err);
  }
}

/**
 * Đồng bộ danh sách quy tắc lên tab __CONFIG__ của Google Sheet (ở mục Custom Settings)
 */
export async function syncLearnedRulesToSheetConfig(
  accessToken: string,
  spreadsheetId: string,
  rules: ConsensusRule[]
): Promise<boolean> {
  try {
    if (!accessToken || !spreadsheetId) return false;
    const syncState = await readMasterSyncStateFromGoogleSheet(accessToken, spreadsheetId);
    if (!syncState) return false;

    const existingMeta = syncState.metadata;
    const customSettings = {
      ...(existingMeta.customSettings || {}),
      learnedRules: rules,
      learnedRulesUpdatedAt: Date.now(),
    };

    const ok = await saveMasterSyncStateToGoogleSheet(accessToken, spreadsheetId, {
      ...existingMeta,
      customSettings,
      members: syncState.members || [],
      updatedAt: new Date().toISOString(),
    });

    if (ok) {
      console.log(`[CurationLearning] Đã lưu ${rules.length} quy tắc vào tab __CONFIG__ của Google Sheet.`);
    }
    return ok;
  } catch (err) {
    console.warn('[CurationLearning] syncLearnedRulesToSheetConfig lỗi:', err);
    return false;
  }
}

export interface ProposalInputItem {
  originalTitle: string;
  proposedTitle: string;
  originalAuthor: string;
  proposedAuthor: string;
  category?: string;
  publisher?: string;
  selected: boolean;
}

/**
 * Thuật toán suy diễn quy tắc tại máy (Rule Induction Heuristics):
 * Phân tích đối chiếu giữa dữ liệu gốc và dữ liệu được người dùng duyệt
 */
export function synthesizeRulesFromProposals(proposals: ProposalInputItem[]): ConsensusRule[] {
  const newRules: ConsensusRule[] = [];
  const approved = proposals.filter((p) => p.selected);

  for (const item of approved) {
    const origAuth = (item.originalAuthor || '').trim();
    const propAuth = (item.proposedAuthor || '').trim();
    const origTitle = (item.originalTitle || '').trim();
    const propTitle = (item.proposedTitle || '').trim();

    // 1. Kiểm tra tiền tố học hàm ở tác giả
    const prefixMatch = origAuth.match(/^(BS\.|ThS\.|TS\.|GS\.|Bác sĩ|Thạc sĩ|Tiến sĩ|Giáo sư)\s+/i);
    if (prefixMatch && !propAuth.match(/^(BS\.|ThS\.|TS\.|GS\.|Bác sĩ|Thạc sĩ|Tiến sĩ|Giáo sư)\s+/i)) {
      newRules.push({
        id: 'rule_author_prefix_strip',
        type: 'AUTHOR_PREFIX_STRIP',
        title: 'Xóa danh xưng học hàm trước tên tác giả',
        description: 'Tự động lược bỏ các tiền tố học hàm như BS., ThS., TS., GS., Bác sĩ, Thạc sĩ trước tên tác giả',
        targetField: 'author',
        pattern: '^(BS\\.|ThS\\.|TS\\.|GS\\.|Bác sĩ|Thạc sĩ|Tiến sĩ|Giáo sư)\\s+',
        action: 'STRIP',
        source: 'USER_LOCAL',
        voteCount: 1,
        confidenceRate: 0.95,
        updatedAt: Date.now(),
      });
    }

    // 2. Kiểm tra vai trò phụ chú tác giả trong ngoặc
    const editorialMatch = origAuth.match(/\s*\((chủ biên|biên dịch|dịch giả|tuyển chọn|cb)\)$/i);
    if (editorialMatch && !propAuth.match(/\s*\((chủ biên|biên dịch|dịch giả|tuyển chọn|cb)\)$/i)) {
      newRules.push({
        id: 'rule_author_editorial_strip',
        type: 'AUTHOR_EDITORIAL_STRIP',
        title: 'Xóa vai trò phụ chú biên soạn sau tên tác giả',
        description: 'Xóa phần phụ chú trong ngoặc đơn như (Chủ biên), (Biên dịch), (Dịch giả) ở cuối tên tác giả',
        targetField: 'author',
        pattern: '\\s*\\((chủ biên|biên dịch|dịch giả|tuyển chọn|cb)\\)$',
        action: 'STRIP',
        source: 'USER_LOCAL',
        voteCount: 1,
        confidenceRate: 0.95,
        updatedAt: Date.now(),
      });
    }

    // 3. Kiểm tra bảo toàn phụ đề
    if (origTitle.includes(':') && propTitle.includes(':')) {
      newRules.push({
        id: 'rule_subtitle_preserve',
        type: 'SUBTITLE_PRESERVE',
        title: 'Bảo toàn phụ đề sau dấu hai chấm',
        description: 'Giữ nguyên phần phụ đề sau dấu hai chấm (:) hoặc gạch nối (-) khi chuẩn hóa tiêu đề sách',
        targetField: 'title',
        pattern: ':\\s*.+',
        action: 'PRESERVE',
        source: 'USER_LOCAL',
        voteCount: 1,
        confidenceRate: 0.92,
        updatedAt: Date.now(),
      });
    }

    // 4. Kiểm tra phân loại thể loại theo từ khóa tiêu đề
    if (item.category && item.category !== 'Chung') {
      const cleanTitleNoTones = removeVietnameseTones(propTitle).toLowerCase();
      const cleanCatNoTones = removeVietnameseTones(item.category).toLowerCase();

      // Kiểm tra một số thể loại phổ biến
      if (cleanCatNoTones.includes('kinh te') && (cleanTitleNoTones.includes('kinh te') || cleanTitleNoTones.includes('dau tu') || cleanTitleNoTones.includes('tai chinh') || cleanTitleNoTones.includes('chung khoan'))) {
        newRules.push({
          id: 'rule_cat_keyword_kinhte',
          type: 'CATEGORY_KEYWORD_MAP',
          title: 'Nhận diện sách Kinh tế qua từ khóa tiêu đề',
          description: 'Gán thể loại Kinh Tế khi tiêu đề chứa từ khóa kinh tế, đầu tư, chứng khoán, tài chính',
          targetField: 'category',
          pattern: '(kinh tế|đầu tư|chứng khoán|tài chính|doanh nghiệp)',
          action: 'SET_CATEGORY',
          value: item.category,
          source: 'USER_LOCAL',
          voteCount: 1,
          confidenceRate: 0.9,
          updatedAt: Date.now(),
        });
      } else if (cleanCatNoTones.includes('trinh tham') && (cleanTitleNoTones.includes('trinh tham') || cleanTitleNoTones.includes('vu an') || cleanTitleNoTones.includes('pha an') || cleanTitleNoTones.includes('conan') || cleanTitleNoTones.includes('holmes'))) {
        newRules.push({
          id: 'rule_cat_keyword_trinhtham',
          type: 'CATEGORY_KEYWORD_MAP',
          title: 'Nhận diện sách Trinh thám qua từ khóa tiêu đề',
          description: 'Gán thể loại Trinh thám khi tiêu đề chứa từ khóa trinh thám, vụ án, phá án, conan, holmes',
          targetField: 'category',
          pattern: '(trinh thám|vụ án|phá án|conan|holmes|sát nhân)',
          action: 'SET_CATEGORY',
          value: item.category,
          source: 'USER_LOCAL',
          voteCount: 1,
          confidenceRate: 0.92,
          updatedAt: Date.now(),
        });
      }
    }
  }

  return newRules;
}

/**
 * Trích xuất quy tắc phân biệt tập từ hành vi duyệt trùng lặp
 */
export function synthesizeRulesFromDuplicateReview(keptBooks: BookRecord[]): ConsensusRule[] {
  const newRules: ConsensusRule[] = [];
  if (keptBooks.length < 2) return newRules;

  // Kiểm tra xem các cuốn được giữ lại có phân biệt bằng số tập không
  for (let i = 0; i < keptBooks.length; i++) {
    for (let j = i + 1; j < keptBooks.length; j++) {
      const b1 = keptBooks[i];
      const b2 = keptBooks[j];
      const vol1 = canonicalizeVolume(b1.title);
      const vol2 = canonicalizeVolume(b2.title);

      if (vol1 && vol2 && vol1 !== vol2) {
        newRules.push({
          id: 'rule_volume_disambiguation',
          type: 'VOLUME_DISAMBIGUATION',
          title: 'Phân biệt các tập độc lập của cùng bộ sách',
          description: 'Hai cuốn sách có cùng tựa đề gốc nhưng khác số tập là tác phẩm riêng biệt, không gộp trùng',
          targetField: 'pair',
          pattern: 'SAME_TITLE_DIFFERENT_VOLUME',
          action: 'MARK_DISTINCT',
          source: 'USER_LOCAL',
          voteCount: 1,
          confidenceRate: 0.99,
          updatedAt: Date.now(),
        });
        break;
      }
    }
  }

  return newRules;
}

/**
 * Ghi nhận các đề xuất được duyệt, tổng hợp quy tắc và nạp nóng vào bộ nhớ ngay lập tức (Hot Reload).
 * Đồng thời đẩy ngầm vào Google Sheet __CONFIG__ nếu có thông tin kết nối.
 */
export function recordApprovedProposalsAndHotReload(
  proposals: ProposalInputItem[],
  sheetContext?: { accessToken?: string; spreadsheetId?: string }
): ConsensusRule[] {
  const synthesized = synthesizeRulesFromProposals(proposals);
  if (synthesized.length === 0) return getActiveLearnedRules();

  const currentRules = getActiveLearnedRules();
  const ruleMap = new Map<string, ConsensusRule>();

  for (const r of currentRules) {
    ruleMap.set(r.id, r);
  }

  for (const newR of synthesized) {
    const existing = ruleMap.get(newR.id);
    if (existing) {
      const updated: ConsensusRule = {
        ...existing,
        voteCount: (existing.voteCount || 0) + 1,
        confidenceRate: Math.min(0.99, (existing.confidenceRate || 0.9) + 0.01),
        updatedAt: Date.now(),
      };
      ruleMap.set(newR.id, updated);
      // Ghi nhận vào delta chờ flush lên Cloud
      pendingSessionRuleVotes.set(newR.id, { rule: updated, voteDelta: (pendingSessionRuleVotes.get(newR.id)?.voteDelta || 0) + 1 });
    } else {
      ruleMap.set(newR.id, newR);
      pendingSessionRuleVotes.set(newR.id, { rule: newR, voteDelta: 1 });
    }
  }

  const updatedRulesList = Array.from(ruleMap.values());
  // 1. Lưu tức thì vào LocalStorage (< 2ms)
  saveLearnedRulesLocally(updatedRulesList);

  // 2. Đẩy ngầm vào Google Sheet __CONFIG__ nếu có kết nối
  if (sheetContext?.accessToken && sheetContext?.spreadsheetId) {
    syncLearnedRulesToSheetConfig(sheetContext.accessToken, sheetContext.spreadsheetId, updatedRulesList).catch((e) => {
      console.warn('[CurationLearning] Lưu rules ngầm lên Sheet Config có cảnh báo:', e);
    });
  }

  console.log(`[CurationLearning] Đã đúc kết và nạp nóng ${synthesized.length} quy tắc mới vào bộ nhớ!`);
  return updatedRulesList;
}

/**
 * Ghi nhận các sách giữ lại trong duyệt trùng lặp, tổng hợp quy tắc phân biệt tập và nạp nóng.
 */
export function recordKeptDuplicatesAndHotReload(
  keptBooks: BookRecord[],
  sheetContext?: { accessToken?: string; spreadsheetId?: string }
): ConsensusRule[] {
  const synthesized = synthesizeRulesFromDuplicateReview(keptBooks);
  if (synthesized.length === 0) return getActiveLearnedRules();

  const currentRules = getActiveLearnedRules();
  const ruleMap = new Map<string, ConsensusRule>();

  for (const r of currentRules) {
    ruleMap.set(r.id, r);
  }

  for (const newR of synthesized) {
    const existing = ruleMap.get(newR.id);
    if (existing) {
      const updated: ConsensusRule = {
        ...existing,
        voteCount: (existing.voteCount || 0) + 1,
        confidenceRate: Math.min(0.99, (existing.confidenceRate || 0.9) + 0.01),
        updatedAt: Date.now(),
      };
      ruleMap.set(newR.id, updated);
      pendingSessionRuleVotes.set(newR.id, { rule: updated, voteDelta: (pendingSessionRuleVotes.get(newR.id)?.voteDelta || 0) + 1 });
    } else {
      ruleMap.set(newR.id, newR);
      pendingSessionRuleVotes.set(newR.id, { rule: newR, voteDelta: 1 });
    }
  }

  const updatedRulesList = Array.from(ruleMap.values());
  saveLearnedRulesLocally(updatedRulesList);

  if (sheetContext?.accessToken && sheetContext?.spreadsheetId) {
    syncLearnedRulesToSheetConfig(sheetContext.accessToken, sheetContext.spreadsheetId, updatedRulesList).catch(() => {});
  }

  return updatedRulesList;
}

/**
 * Gửi đóng góp các quy tắc đã tích lũy lên Cloud Firestore.
 * CHỈ GỌI 1 LẦN DUY NHẤT KHI KẾT THÚC TOÀN BỘ QUY TRÌNH CHẠY (End-of-Run Batching).
 */
export async function flushSessionContributionsToCloud(): Promise<boolean> {
  if (pendingSessionRuleVotes.size === 0) {
    return true;
  }

  try {
    const docRef = doc(db, CLOUD_COMMUNITY_DOC_PATH);
    const existingSnap = await getDoc(docRef);

    let cloudRulesMap = new Map<string, ConsensusRule>();

    if (existingSnap.exists()) {
      const data = existingSnap.data();
      if (Array.isArray(data.rules)) {
        for (const r of data.rules) {
          if (r && r.id) {
            cloudRulesMap.set(r.id, r);
          }
        }
      }
    } else {
      // Khởi tạo từ default baseline nếu doc chưa tồn tại
      for (const r of DEFAULT_BASELINE_RULES) {
        cloudRulesMap.set(r.id, r);
      }
    }

    // Áp dụng các delta từ phiên làm việc này
    for (const [ruleId, delta] of pendingSessionRuleVotes.entries()) {
      const existing = cloudRulesMap.get(ruleId);
      if (existing) {
        cloudRulesMap.set(ruleId, {
          ...existing,
          voteCount: (existing.voteCount || 0) + delta.voteDelta,
          confidenceRate: Math.min(0.99, (existing.confidenceRate || 0.9) + 0.005 * delta.voteDelta),
          updatedAt: Date.now(),
        });
      } else {
        cloudRulesMap.set(ruleId, {
          ...delta.rule,
          source: 'COMMUNITY',
          voteCount: (delta.rule.voteCount || 1) + delta.voteDelta,
          updatedAt: Date.now(),
        });
      }
    }

    const payload = {
      rules: Array.from(cloudRulesMap.values()),
      totalRules: cloudRulesMap.size,
      updatedAt: Date.now(),
      version: '1.0.0',
    };

    await setDoc(docRef, payload, { merge: true });
    console.log(`[CurationLearning] Đã gửi đóng góp ${pendingSessionRuleVotes.size} quy tắc lên Cloud Firestore thành công!`);

    // Xóa hàng đợi delta sau khi gửi thành công
    pendingSessionRuleVotes.clear();
    return true;
  } catch (err) {
    console.warn('[CurationLearning] flushSessionContributionsToCloud lỗi mạng/quyền (sẽ thử lại sau):', err);
    return false;
  }
}

/**
 * Kiểm tra và tải bảng quy tắc đồng thuận từ Cloud Firestore đúng 1 LẦN DUY NHẤT khi mở ứng dụng.
 */
export async function syncStartupCloudRulesOnce(): Promise<void> {
  if (hasCheckedCloudRulesThisSession) {
    return;
  }
  hasCheckedCloudRulesThisSession = true;

  try {
    const docRef = doc(db, CLOUD_COMMUNITY_DOC_PATH);
    const snap = await getDoc(docRef);

    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.rules) && data.rules.length > 0) {
        const cloudRules: ConsensusRule[] = data.rules;
        const localRules = getActiveLearnedRules();
        const mergedMap = new Map<string, ConsensusRule>();

        // Nạp cloud rules
        for (const cr of cloudRules) {
          if (cr && cr.id) {
            mergedMap.set(cr.id, cr);
          }
        }

        // Hợp nhất với local rules (giữ voteCount cao nhất)
        for (const lr of localRules) {
          if (lr && lr.id) {
            const existing = mergedMap.get(lr.id);
            if (!existing || (lr.voteCount || 0) > (existing.voteCount || 0)) {
              mergedMap.set(lr.id, lr);
            }
          }
        }

        const mergedList = Array.from(mergedMap.values());
        saveLearnedRulesLocally(mergedList);
        console.log(`[CurationLearning] Đã cập nhật ${cloudRules.length} quy tắc đồng thuận từ Cloud Firestore lúc mở app.`);
      }
    }
  } catch (err) {
    console.warn('[CurationLearning] Bỏ qua kiểm tra Cloud Rules lúc mở app (chế độ offline):', err);
  }
}

/**
 * Áp dụng tiền xử lý quy tắc cục bộ lên một cuốn sách trước khi cần gửi sang AI.
 */
export function applyActiveRulesToBookRecord(book: BookRecord, activeRules: ConsensusRule[]): BookRecord {
  let { title, author, category, publisher } = book;
  title = title || '';
  author = author || '';

  for (const rule of activeRules) {
    if (rule.type === 'AUTHOR_PREFIX_STRIP' && rule.pattern) {
      try {
        const re = new RegExp(rule.pattern, 'i');
        author = author.replace(re, '').trim();
      } catch {}
    } else if (rule.type === 'AUTHOR_EDITORIAL_STRIP' && rule.pattern) {
      try {
        const re = new RegExp(rule.pattern, 'i');
        author = author.replace(re, '').trim();
      } catch {}
    } else if (rule.type === 'CATEGORY_KEYWORD_MAP' && rule.pattern && rule.value) {
      if (!category || category === 'Chung') {
        try {
          const re = new RegExp(rule.pattern, 'i');
          if (re.test(title)) {
            category = rule.value;
          }
        } catch {}
      }
    }
  }

  return {
    ...book,
    title,
    author,
    category,
    publisher,
  };
}

/**
 * Định dạng danh sách quy tắc thành đoạn chỉ dẫn súc tích nạp vào System Instruction của Gemini
 */
export function formatRulesForGeminiPrompt(activeRules: ConsensusRule[]): string {
  if (!activeRules || activeRules.length === 0) return '';
  const topRules = activeRules.slice(0, 5);
  const bulletLines = topRules.map((r) => `- ${r.description}`);
  return `\nQUY TẮC ĐỒNG THUẬN CỘNG ĐỒNG BẮT BUỘC TUÂN THỦ:\n${bulletLines.join('\n')}\n`;
}
