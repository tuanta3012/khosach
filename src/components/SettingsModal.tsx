import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Settings as SettingsIcon,
  Check,
  RefreshCw,
  Sparkles,
  Pause,
  Loader2,
  CheckSquare,
  Square,
  ArrowRight,
  CheckCheck,
  Key,
  ExternalLink,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Sliders,
  Filter,
  AlertTriangle,
  ArrowUpCircle,
  ChevronDown,
  ChevronUp,
  Pencil,
} from 'lucide-react';
import {
  LibrarySettings,
  BookRecord,
  AuthUser,
  BookSource,
  NormalizeFieldKey,
  NORMALIZE_FIELD_OPTIONS,
  DEFAULT_NORMALIZE_FIELDS,
} from '../types';
import { useToast } from '../context/ToastContext';
import { CURRENT_APP_VERSION } from '../version';
import { batchNormalize } from '../utils/geminiService';
import {
  getStoredGeminiApiKeys,
  getEffectiveGeminiKeys,
  saveStoredGeminiApiKeys,
  testGeminiApiKey,
  testAllGeminiApiKeys,
  ensureGeminiAccessAvailable,
} from '../services/geminiService';
import { batchFindBookCovers, PrecomputedCoverHint } from '../services/bookCoverService';
import {
  groupDuplicateBooksAsync,
  DuplicateGroup,
  getBookPairSignatures,
  isMeaningfulChange,
} from '../utils/fuzzyMatcher';
import {
  getLocalIgnoredDuplicatePairs,
  saveLocalIgnoredDuplicatePairs,
  syncIgnoredDuplicatePairsWithDrive,
  SpreadsheetInfo,
  saveUserApiKeyToSheetConfig,
  fetchUserApiKeysFromSheetConfig,
} from '../services/driveSyncService';
import { getAccessToken } from '../services/googleAuthService';
import { saveAllLocalBooks, resolveNormalizeFields } from '../utils/localBooksStorage';
import {
  recordApprovedProposalsAndHotReload,
  recordKeptDuplicatesAndHotReload,
  flushSessionContributionsToCloud,
} from '../services/curationLearningService';
import { downloadLogs } from '../utils/logger';
import {
  clearPendingTitleAuthorProposals,
  loadPendingTitleAuthorProposals,
  PENDING_REVIEWS_CHANGED_EVENT,
  TitleAuthorProposal,
  updatePendingProposalCovers,
  upsertPendingTitleAuthorProposals,
} from '../utils/pendingReviewStorage';

export type { TitleAuthorProposal };

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LibrarySettings;
  onSaveSettings: (newSettings: LibrarySettings) => Promise<void>;
  onCheckUpdates?: () => void;
  books?: BookRecord[];
  onBatchUpdateBooks?: (updatedBooksList: BookRecord[], options?: { skipSync?: boolean }) => Promise<void>;
  onSyncDriveNow?: () => Promise<void>;
  onBatchStateChange?: (active: boolean) => void;
  onBatchDeleteBooks?: (idsToDelete: string[]) => Promise<void>;
  isAutoNormalizing?: boolean;
  appMode?: 'offline' | 'online';
  onSwitchMode?: () => void;
  onOpenFamilyShare?: () => void;
  currentUser?: AuthUser | null;
  onGoogleSignIn?: () => Promise<void>;
  onGoogleLogout?: () => Promise<void>;
  initialExpandKeySection?: boolean;
  onClearLocalBooksOnly?: () => Promise<void>;
  spreadsheetInfo?: SpreadsheetInfo | null;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onCheckUpdates,
  books = [],
  onBatchUpdateBooks,
  onSyncDriveNow,
  onBatchStateChange,
  onBatchDeleteBooks,
  onClearLocalBooksOnly,
  appMode = 'offline',
  onSwitchMode,
  onOpenFamilyShare,
  currentUser,
  onGoogleSignIn,
  onGoogleLogout,
  initialExpandKeySection = false,
  spreadsheetInfo,
}) => {
  const { showToast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [dedupProgress, setDedupProgress] = useState<{ percent: number; current: number; total: number } | null>(null);
  const [dedupScannedCount, setDedupScannedCount] = useState<number>(0);

  // States cho xử lý trùng lặp chọn lọc thủ công
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[] | null>(null);
  const [selectedKeepIds, setSelectedKeepIds] = useState<Record<string, string[]>>({});

  // States cho duyệt đề xuất thay đổi Tên sách & Tác giả sau khi chạy xong hoặc bấm tạm dừng
  const [reviewProposals, setReviewProposals] = useState<TitleAuthorProposal[] | null>(null);
  const [pendingReviewCount, setPendingReviewCount] = useState<number>(() => {
    try {
      return loadPendingTitleAuthorProposals().length;
    } catch {
      return 0;
    }
  });
  const pendingReviewAccumulatorRef = useRef<TitleAuthorProposal[]>(
    loadPendingTitleAuthorProposals()
  );
  const sourceLookupWarningsRef = useRef(new Set<string>());

  // States cho chuẩn hóa bằng AI
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [currentBatchText, setCurrentBatchText] = useState('');
  const [, setProcessedCount] = useState(0);
  const stopNormalizingRef = useRef(false);
  const normalizeAbortControllerRef = useRef<AbortController | null>(null);

  // Mặc định tính năng AI tự động luôn là OFF khi cài app mới
  const [autoNormalize, setAutoNormalize] = useState<boolean>(() => !!settings.autoNormalizeEnabled);

  // Danh sách các trường dữ liệu được chọn để hiệu chỉnh AI
  const [selectedNormalizeFields, setSelectedNormalizeFields] = useState<NormalizeFieldKey[]>(() => {
    return resolveNormalizeFields(settings.normalizeFields);
  });

  useEffect(() => {
    setSelectedNormalizeFields(resolveNormalizeFields(settings.normalizeFields));
  }, [settings.normalizeFields, isOpen]);

  // Trạng thái hoàn tất theo các trường được chọn:
  // Một cuốn sách tính là hoàn tất nếu đã qua AI (is_ai_normalized = true)
  // VÀ không bị thiếu dữ liệu ở các trường người dùng đang chọn hiệu chỉnh
  const isBookComplete = (b: BookRecord) => {
    if (!b.is_ai_normalized) return false;
    if (selectedNormalizeFields.includes('summary') && !b.summary?.trim()) return false;
    if (selectedNormalizeFields.includes('cover_url') && !b.cover_url?.trim()) return false;
    if (selectedNormalizeFields.includes('category') && (!b.category?.trim() || b.category.trim() === 'Chung')) return false;
    if (selectedNormalizeFields.includes('author') && !b.author?.trim()) return false;
    if (selectedNormalizeFields.includes('publisher') && !b.publisher?.trim()) return false;
    return true;
  };

  const totalBooks = books.length;
  const normalizedCount = books.filter(isBookComplete).length;
  const pendingBooks = books.filter((b) => !isBookComplete(b));
  const activeReviewCount = reviewProposals ? reviewProposals.length : (pendingReviewCount || pendingReviewAccumulatorRef.current.length);

  useEffect(() => {
    const syncPendingReviews = () => {
      const latest = loadPendingTitleAuthorProposals();
      pendingReviewAccumulatorRef.current = latest;
      setPendingReviewCount(latest.length);
    };
    if (isOpen) {
      syncPendingReviews();
    }
    window.addEventListener(PENDING_REVIEWS_CHANGED_EVENT, syncPendingReviews);
    return () => window.removeEventListener(PENDING_REVIEWS_CHANGED_EVENT, syncPendingReviews);
  }, [isOpen]);

  useEffect(() => {
    setAutoNormalize(!!settings.autoNormalizeEnabled);
  }, [settings.autoNormalizeEnabled, isOpen]);

  useEffect(() => {
    if (!isOpen && normalizeAbortControllerRef.current) {
      normalizeAbortControllerRef.current.abort();
      normalizeAbortControllerRef.current = null;
      stopNormalizingRef.current = true;
      setIsNormalizing(false);
    }
  }, [isOpen]);

  const handleToggleAutoNormalize = async (val: boolean) => {
    setAutoNormalize(val);
    await onSaveSettings({ ...settings, autoNormalizeEnabled: val });
  };

  const handleToggleNormalizeField = async (fieldKey: NormalizeFieldKey) => {
    const exists = selectedNormalizeFields.includes(fieldKey);
    let updated: NormalizeFieldKey[];
    if (exists) {
      if (selectedNormalizeFields.length === 1) {
        showToast('Vui lòng chọn ít nhất 1 trường để hiệu chỉnh!', 'warning');
        return;
      }
      updated = selectedNormalizeFields.filter((f) => f !== fieldKey);
    } else {
      updated = [...selectedNormalizeFields, fieldKey];
    }
    setSelectedNormalizeFields(updated);
    await onSaveSettings({ ...settings, normalizeFields: updated });
  };

  // States cho danh sách Gemini API Keys cá nhân (hoàn toàn do người dùng nhập, không có key mặc định)
  const [newKeyInput, setNewKeyInput] = useState<string>('');
  
  const getCleanKeys = () => {
    const raw = settings.geminiApiKeys && settings.geminiApiKeys.length > 0
      ? settings.geminiApiKeys
      : getStoredGeminiApiKeys();
    return (raw || []).map((k: string) => String(k || '').trim()).filter(Boolean);
  };

  const [isKeySectionExpanded, setIsKeySectionExpanded] = useState<boolean>(() => {
    return initialExpandKeySection || getCleanKeys().length === 0;
  });

  useEffect(() => {
    if (isOpen && initialExpandKeySection) {
      setIsKeySectionExpanded(true);
    }
  }, [isOpen, initialExpandKeySection]);
  
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    return getCleanKeys();
  });

  useEffect(() => {
    if (!isOpen) return;
    const latest = getCleanKeys();
    if (latest.length > 0 && apiKeys.length === 0) {
      setApiKeys(latest);
    }
  }, [isOpen, settings.geminiApiKeys]);

  const [testingKeysMap, setTestingKeysMap] = useState<Record<string, boolean>>({});
  const [testResultsMap, setTestResultsMap] = useState<Record<string, { success: boolean; message: string }>>({});

  const handleTestSingleKey = async (keyToTest: string, silentToast = false) => {
    const clean = keyToTest.trim();
    if (!clean) return;

    setTestingKeysMap((prev) => ({ ...prev, [clean]: true }));
    try {
      const res = await testGeminiApiKey(clean);
      setTestResultsMap((prev) => ({ ...prev, [clean]: res }));
      if (!silentToast) {
        if (res.success) {
          showToast('Key hoạt động tốt.', 'success');
        } else {
          showToast(res.message || 'Key lỗi. Chờ hoặc thay key mới.', 'error');
        }
      }
    } catch (err: any) {
      setTestResultsMap((prev) => ({
        ...prev,
        [clean]: { success: false, message: 'Key lỗi. Chờ hoặc thay key mới.' },
      }));
      if (!silentToast) {
        showToast('Key lỗi. Chờ hoặc thay key mới.', 'error');
      }
    } finally {
      setTestingKeysMap((prev) => ({ ...prev, [clean]: false }));
    }
  };

  const handleTestAllKeys = async () => {
    if (apiKeys.length === 0) return;
    const pendingMap: Record<string, boolean> = {};
    for (const k of apiKeys) pendingMap[k] = true;
    setTestingKeysMap((prev) => ({ ...prev, ...pendingMap }));
    try {
      const results = await testAllGeminiApiKeys(apiKeys);
      setTestResultsMap((prev) => ({ ...prev, ...results }));
      const okCount = Object.values(results).filter((r) => r.success).length;
      showToast(
        okCount === apiKeys.length
          ? `${okCount}/${apiKeys.length} Key hoạt động tốt.`
          : `${okCount}/${apiKeys.length} Key OK.`,
        okCount > 0 ? 'info' : 'error'
      );
    } finally {
      const doneMap: Record<string, boolean> = {};
      for (const k of apiKeys) doneMap[k] = false;
      setTestingKeysMap((prev) => ({ ...prev, ...doneMap }));
    }
  };

  const handleAddKey = async () => {
    const parsedCandidates = newKeyInput
      .split(/[,;\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (parsedCandidates.length === 0) return;

    const existingSet = new Set(apiKeys);
    const newlyAdded: string[] = [];
    for (const candidate of parsedCandidates) {
      if (!existingSet.has(candidate)) {
        existingSet.add(candidate);
        newlyAdded.push(candidate);
      }
    }

    if (newlyAdded.length === 0) {
      showToast('API Key này đã tồn tại trong danh sách!', 'warning');
      return;
    }

    const updatedKeys = [...apiKeys, ...newlyAdded];
    saveStoredGeminiApiKeys(updatedKeys);
    setApiKeys(updatedKeys);
    setNewKeyInput(''); // Xóa trắng ô nhập sau khi hoàn thành
    await onSaveSettings({ ...settings, geminiApiKeys: updatedKeys });

    if (newlyAdded.length > 1) {
      showToast(`Đã thêm ${newlyAdded.length} Gemini API Key mới!`, 'success');
    }

    // Tự động đồng bộ lên Google Sheet Config nếu người dùng là Admin hoặc Editor
    if (
      currentUser &&
      (currentUser.userRole === 'ADMIN' || currentUser.userRole === 'EDITOR') &&
      currentUser.email &&
      spreadsheetInfo?.id
    ) {
      getAccessToken().then(async (token) => {
        if (token && spreadsheetInfo?.id) {
          const synced = await saveUserApiKeyToSheetConfig(
            token,
            spreadsheetInfo.id,
            currentUser.email,
            updatedKeys,
            currentUser.userRole
          );
          if (synced) {
            showToast('Đã lưu & đồng bộ API Key lên Google Sheet!', 'success');
          }
        }
      }).catch(() => {});
    }

    // Tự động kiểm tra các key vừa thêm
    if (newlyAdded.length === 1) {
      handleTestSingleKey(newlyAdded[0]);
    } else {
      Promise.all(newlyAdded.map((k) => handleTestSingleKey(k, true))).catch(() => {});
    }
  };

  const handleDeleteKey = async (keyToDelete: string) => {
    const updatedKeys = apiKeys.filter((k) => k !== keyToDelete);
    saveStoredGeminiApiKeys(updatedKeys);
    setApiKeys(updatedKeys);
    await onSaveSettings({ ...settings, geminiApiKeys: updatedKeys });

    // Đồng bộ lại danh sách sau khi xóa lên Sheet Config nếu là Admin hoặc Editor
    if (
      currentUser &&
      (currentUser.userRole === 'ADMIN' || currentUser.userRole === 'EDITOR') &&
      currentUser.email &&
      spreadsheetInfo?.id
    ) {
      getAccessToken().then(async (token) => {
        if (token && spreadsheetInfo?.id) {
          await saveUserApiKeyToSheetConfig(
            token,
            spreadsheetInfo.id,
            currentUser.email,
            updatedKeys,
            currentUser.userRole
          );
        }
      }).catch(() => {});
    }

    showToast('Đã xóa Gemini API Key!', 'info');
  };

  // Tự động đồng bộ nạp API Key từ Google Sheet Config về máy nếu máy này chưa có key
  useEffect(() => {
    if (
      isOpen &&
      apiKeys.length === 0 &&
      currentUser &&
      (currentUser.userRole === 'ADMIN' || currentUser.userRole === 'EDITOR') &&
      currentUser.email &&
      spreadsheetInfo?.id
    ) {
      getAccessToken().then(async (token) => {
        if (token && spreadsheetInfo?.id && currentUser?.email) {
          const remoteKeys = await fetchUserApiKeysFromSheetConfig(token, spreadsheetInfo.id, currentUser.email);
          if (remoteKeys && remoteKeys.length > 0) {
            setApiKeys(remoteKeys);
            saveStoredGeminiApiKeys(remoteKeys);
            await onSaveSettings({ ...settings, geminiApiKeys: remoteKeys });
            showToast('✨ Đã tự động nhận Gemini API Key của bạn từ Google Sheet!', 'info');
          }
        }
      }).catch(() => {});
    }
  }, [isOpen, currentUser?.email, currentUser?.userRole, spreadsheetInfo?.id]);

  if (!isOpen) return null;

  const handleStartNormalize = async () => {
    console.log(
      `[Normalize] Bấm "Hiệu chỉnh thủ công": total=${books.length}, pending=${pendingBooks.length}, ` +
        `localKeys=${apiKeys.length}, role=${currentUser?.userRole || 'none'}, isNormalizing=${isNormalizing}`
    );

    if (isNormalizing) return;

    if (currentUser?.userRole === 'VIEWER') {
      showToast('Tài khoản Xem (Viewer) không có quyền hiệu chỉnh kho sách.', 'warning');
      return;
    }

    if (!onBatchUpdateBooks) {
      showToast('Chức năng cập nhật kho sách chưa sẵn sàng. Vui lòng thử lại.', 'error');
      return;
    }

    if (books.length === 0) {
      showToast('Kho sách đang trống, chưa có sách nào để hiệu chỉnh.', 'info');
      return;
    }

    if (pendingBooks.length === 0) {
      setCurrentBatchText('Đã hiệu chỉnh hết — bấm "Làm lại" nếu muốn chạy lại.');
      showToast(
        `Tất cả ${books.length} cuốn sách đã hiệu chỉnh xong. Bấm "Làm lại" để hiệu chỉnh lại từ đầu!`,
        'info',
        4500
      );
      return;
    }

    // Đảm bảo đồng bộ API Keys vào storage trước khi chạy
    let storedKeys = getStoredGeminiApiKeys();
    const fallbackCleanKeys = getCleanKeys();
    if (storedKeys.length === 0 && fallbackCleanKeys.length > 0) {
      saveStoredGeminiApiKeys(fallbackCleanKeys);
      storedKeys = getStoredGeminiApiKeys();
      if (apiKeys.length === 0) {
        setApiKeys(fallbackCleanKeys);
      }
    }

    const effectiveKeys = getEffectiveGeminiKeys();
    const hasAccess = effectiveKeys.length > 0 || (await ensureGeminiAccessAvailable());
    const finalKeys = getEffectiveGeminiKeys();
    if (!hasAccess || finalKeys.length === 0) {
      setIsKeySectionExpanded(true);
      setCurrentBatchText('Chưa có Gemini API Key — vui lòng thêm Key ở mục trên.');
      showToast('Vui lòng thêm và lưu ít nhất 1 Gemini API Key trước khi hiệu chỉnh kho!', 'warning', 4500);
      return;
    }

    const abortController = new AbortController();
    normalizeAbortControllerRef.current = abortController;
    setIsNormalizing(true);
    onBatchStateChange?.(true);
    stopNormalizingRef.current = false;
    if (!pendingReviewAccumulatorRef.current) {
      pendingReviewAccumulatorRef.current = [];
    }
    setPendingReviewCount(pendingReviewAccumulatorRef.current.length);
    sourceLookupWarningsRef.current.clear();
    const localPending = [...pendingBooks];
    const localPendingById = new Map(localPending.map((b) => [b.id, b]));
    const normalizeStartedAt = Date.now();
    let currentProcessed = 0;
    let hasLocalUpdates = false;

    const activeFields = selectedNormalizeFields.length > 0
      ? selectedNormalizeFields
      : resolveNormalizeFields(settings.normalizeFields);
    const applyTitle = activeFields.includes('title');
    const applyAuthor = activeFields.includes('author');
    const applyCategory = activeFields.includes('category');
    const applyPublisher = activeFields.includes('publisher');
    const applySummary = activeFields.includes('summary');
    const applyCover = activeFields.includes('cover_url');

    console.log(
      `[Normalize] Khởi chạy hiệu chỉnh thủ công: ${localPending.length} cuốn • ${Math.max(1, finalKeys.length)} Key • ` +
        `trường=[${activeFields.join(', ')}] • model=gemini-3.5-flash-lite`
    );
    setCurrentBatchText(`Đang kết nối Gemini 3.5 Flash Lite (${Math.max(1, finalKeys.length)} Key) hiệu chỉnh song song...`);

    const coverHintsMap = new Map<string, PrecomputedCoverHint>();
    const booksNeedingCoverMap = new Map<string, BookRecord>();

    const onChunkComplete = async (normalizedChunk: any[], remaining: number) => {
      if (!normalizedChunk || normalizedChunk.length === 0) return;

      const safeUpdatedList: BookRecord[] = [];
      const chunkProposals: TitleAuthorProposal[] = [];
      for (const normItem of normalizedChunk) {
        if (normItem.sourceWarning) sourceLookupWarningsRef.current.add(normItem.sourceWarning);
        const orig = localPendingById.get(normItem.id);
        if (!orig) continue;

        const normTitleTrim = String(normItem.title || '').trim();
        const origTitleTrim = (orig.title || '').trim();
        const normAuthorTrim = String(normItem.author || '').trim();
        const origAuthorTrim = (orig.author || '').trim();

        const titleMeaningfullyChanged = applyTitle && isMeaningfulChange(origTitleTrim, normTitleTrim, false);
        const authorMeaningfullyChanged = applyAuthor && isMeaningfulChange(origAuthorTrim, normAuthorTrim, true);

        const enrichedCategory = applyCategory ? (normItem.category || orig.category || 'Chung') : (orig.category || 'Chung');
        const enrichedPublisher = applyPublisher ? (normItem.publisher || orig.publisher || '') : (orig.publisher || '');

        const resolvedTitle = !applyTitle ? orig.title : (titleMeaningfullyChanged ? orig.title : (normTitleTrim || orig.title));
        const resolvedAuthor = !applyAuthor ? orig.author : (authorMeaningfullyChanged ? orig.author : (normAuthorTrim || orig.author));
        const enrichedSummary = applySummary ? ((normItem.summary && String(normItem.summary).trim()) || orig.summary || '') : (orig.summary || '');

        coverHintsMap.set(orig.id, {
          alreadyAnalyzedByAi: true,
          ...(normItem.originalTitle ? { originalTitle: String(normItem.originalTitle).trim() } : {}),
          ...(normItem.isbn ? { isbn: String(normItem.isbn).trim() } : {}),
        });

        const existingCover = (orig.cover_url || '').trim();
        const hasValidExistingCover = Boolean(existingCover && existingCover.toUpperCase() !== 'NONE');

        const updatedBook: BookRecord = {
          ...orig,
          title: resolvedTitle,
          author: resolvedAuthor,
          publisher: enrichedPublisher,
          category: enrichedCategory,
          ...(enrichedSummary ? { summary: enrichedSummary } : {}),
          ...(hasValidExistingCover ? { cover_url: existingCover } : {}),
          is_ai_normalized: true,
          updated_at: Date.now(),
        };

        if (applyCover && !hasValidExistingCover) {
          booksNeedingCoverMap.set(orig.id, {
            ...updatedBook,
            title: normTitleTrim || resolvedTitle,
            author: normAuthorTrim || resolvedAuthor,
          });
        }

        safeUpdatedList.push(updatedBook);

        if (titleMeaningfullyChanged || authorMeaningfullyChanged) {
          chunkProposals.push({
            bookId: orig.id,
            originalTitle: orig.title,
            proposedTitle: normTitleTrim,
            titleChanged: titleMeaningfullyChanged,
            originalAuthor: orig.author,
            proposedAuthor: normAuthorTrim,
            authorChanged: authorMeaningfullyChanged,
            category: enrichedCategory,
            publisher: enrichedPublisher,
            summary: enrichedSummary,
            cover_url: hasValidExistingCover ? existingCover : '',
            sources: normItem.sources || [],
            selected: true,
          });
        }
      }

      if (chunkProposals.length > 0) {
        const persisted = upsertPendingTitleAuthorProposals(chunkProposals);
        pendingReviewAccumulatorRef.current = persisted;
      }

      if (safeUpdatedList.length > 0) {
        // Chỉ lưu cục bộ trong lúc đang chạy lô để tránh đồng bộ Drive chồng chéo & tốn quota
        await onBatchUpdateBooks(safeUpdatedList, { skipSync: true });
        hasLocalUpdates = true;
        currentProcessed += safeUpdatedList.length;
        setProcessedCount(currentProcessed);
      }

      setPendingReviewCount(pendingReviewAccumulatorRef.current.length);
      if (!stopNormalizingRef.current && !abortController.signal.aborted) {
        setCurrentBatchText(
          remaining > 0
            ? `Đang hiệu chỉnh: còn ${remaining} cuốn...`
            : applyCover && booksNeedingCoverMap.size > 0
            ? `Chuẩn bị tìm ảnh bìa song song (${booksNeedingCoverMap.size} cuốn)...`
            : `Đang hoàn tất...`
        );
      }
    };

    try {
      const res = await batchNormalize(localPending, {
        onChunkComplete,
        onProgress: (status) => {
          if (!stopNormalizingRef.current && !abortController.signal.aborted) {
            setCurrentBatchText(status);
          }
        },
        normalizeFields: activeFields,
        stopSignal: stopNormalizingRef,
        abortSignal: abortController.signal,
        categories: settings.categoriesList,
        withSources: false,
      });

      const phase1Sec = ((Date.now() - normalizeStartedAt) / 1000).toFixed(1);
      console.log(
        `[Normalize] Xong pha 1 sau ${phase1Sec}s: ${currentProcessed} cuốn, ` +
          `${pendingReviewAccumulatorRef.current.length} đề xuất chờ duyệt, thiếu bìa=${booksNeedingCoverMap.size}`
      );

      // Pha 2: Tìm ảnh bìa song song qua thư mục mở cho các cuốn chưa có bìa (chỉ chạy khi có chọn trường cover_url)
      const missingCoverTargets = applyCover ? Array.from(booksNeedingCoverMap.values()) : [];
      if (applyCover && !stopNormalizingRef.current && !abortController.signal.aborted && missingCoverTargets.length > 0) {
        const phase2StartedAt = Date.now();
        setCurrentBatchText(`Đang tìm ảnh bìa song song (${missingCoverTargets.length} cuốn)...`);
        const coverRes = await batchFindBookCovers(missingCoverTargets, {
          overwriteExisting: false,
          enrichSummary: false,
          useAiFallback: false,
          skipGrounding: true,
          precomputedHints: coverHintsMap,
          catalogWorkers: 12,
          stopSignal: stopNormalizingRef,
          onProgress: (prog) => {
            if (!stopNormalizingRef.current && !abortController.signal.aborted && prog.statusMessage) {
              setCurrentBatchText(prog.statusMessage);
            }
          },
          onChunkSave: async (coverUpdates) => {
            if (!coverUpdates || coverUpdates.length === 0) return;
            const coverMap = new Map<string, string>();
            const proposalById = new Map(pendingReviewAccumulatorRef.current.map((p) => [p.bookId, p]));
            const syncedUpdates = coverUpdates.map((cu) => {
              const existingOrig = localPendingById.get(cu.id);
              const matchingProposal = proposalById.get(cu.id);
              if (cu.cover_url && cu.cover_url !== 'NONE') {
                coverMap.set(cu.id, cu.cover_url);
                if (matchingProposal) {
                  matchingProposal.cover_url = cu.cover_url;
                }
              }
              return {
                ...cu,
                title: matchingProposal?.titleChanged
                  ? (existingOrig?.title || cu.title)
                  : cu.title,
                author: matchingProposal?.authorChanged
                  ? (existingOrig?.author || cu.author)
                  : cu.author,
                is_ai_normalized: true,
              };
            });
            if (coverMap.size > 0) {
              pendingReviewAccumulatorRef.current = updatePendingProposalCovers(coverMap);
            }
            await onBatchUpdateBooks(syncedUpdates, { skipSync: true });
            hasLocalUpdates = true;
          },
        });
        console.log(
          `[Normalize] Xong pha 2 (bìa) sau ${((Date.now() - phase2StartedAt) / 1000).toFixed(1)}s: cập nhật ${coverRes.updatedCount} bìa`
        );
      }

      if (stopNormalizingRef.current || abortController.signal.aborted) {
        // Người dùng đã chủ động bấm Dừng
        if (currentProcessed > 0) {
          showToast(`Đã dừng sau khi hiệu chỉnh ${currentProcessed} cuốn sách.`, 'info');
        }
      } else if (res.normalized.length > 0 && res.failedChunks.length > 0) {
        const failedBookCount = res.failedChunks.reduce((count, chunk) => count + chunk.bookIds.length, 0);
        showToast(`Đã hiệu chỉnh ${currentProcessed} cuốn; ${failedBookCount} cuốn chưa xử lý và có thể chạy lại thủ công.`, 'warning');
      } else if (currentProcessed > 0 && res.success) {
        showToast(`Đã hoàn tất hiệu chỉnh ${currentProcessed} cuốn sách!`, 'success');
      } else if (!stopNormalizingRef.current) {
        const failure = res.failedChunks[0]?.message;
        showToast(failure
          ? `Không thể hiệu chỉnh ${res.failedChunks.reduce((count, chunk) => count + chunk.bookIds.length, 0)} cuốn: ${failure}.`
          : 'Không có sách nào được chuẩn hóa. Vui lòng kiểm tra lại API Key hoặc hạn ngạch!', 'warning');
      }
    } catch (err: any) {
      if (stopNormalizingRef.current || abortController.signal.aborted || err?.message === 'CLIENT_ABORTED') {
        console.log('[Normalize] Đã dừng hiệu chỉnh theo yêu cầu của người dùng.');
      } else {
        console.error('[Normalize] Lỗi khi chuẩn hóa lô:', err);
        showToast(`Lỗi chuẩn hóa: ${err?.message || String(err)}`, 'error');
      }
    } finally {
      onBatchStateChange?.(false);
      setIsNormalizing(false);
      normalizeAbortControllerRef.current = null;
      // Đồng bộ Drive ngầm không làm đơ giao diện người dùng
      if (hasLocalUpdates && onSyncDriveNow) {
        onSyncDriveNow().catch((syncErr) => {
          console.warn('[Normalize] Lỗi đồng bộ Drive sau hiệu chỉnh:', syncErr);
        });
      }
      console.log(
        `[Normalize] Tổng thời gian hiệu chỉnh thủ công: ${((Date.now() - normalizeStartedAt) / 1000).toFixed(1)}s`
      );
      if (!stopNormalizingRef.current) {
        setCurrentBatchText('');
      }
      setProcessedCount(0);
    }

    if (stopNormalizingRef.current) {
      const proposals = pendingReviewAccumulatorRef.current;
      if (proposals.length > 0) {
        setReviewProposals([...proposals]);
      }
      return;
    }

    const proposals = pendingReviewAccumulatorRef.current;
    if (proposals.length > 0) {
      setReviewProposals([...proposals]);
    } else {
      flushSessionContributionsToCloud().catch(() => {});
    }
  };

  const handleStopNormalize = () => {
    stopNormalizingRef.current = true;
    if (normalizeAbortControllerRef.current) {
      normalizeAbortControllerRef.current.abort();
      normalizeAbortControllerRef.current = null;
    }
    setIsNormalizing(false);
    onBatchStateChange?.(false);
    setCurrentBatchText('Đã dừng hiệu chỉnh.');

    const proposals = pendingReviewAccumulatorRef.current;
    if (proposals.length > 0) {
      console.log('[Normalize] Bấm Dừng -> Mở danh sách duyệt:', proposals.length);
      setReviewProposals([...proposals]);
      showToast(`Đã dừng. Có ${proposals.length} cuốn sách cần duyệt đổi tên/tác giả.`, 'info');
    } else {
      showToast('Đã dừng hiệu chỉnh.', 'info');
    }
  };

  const toggleProposalSelect = (index: number) => {
    setReviewProposals((prev) => {
      if (!prev) return null;
      const copy = [...prev];
      copy[index] = { ...copy[index], selected: !copy[index].selected };
      return copy;
    });
  };

  const handleUpdateProposalTitle = (index: number, newTitle: string) => {
    setReviewProposals((prev) => {
      if (!prev) return null;
      const copy = [...prev];
      copy[index] = { ...copy[index], proposedTitle: newTitle, titleChanged: true };
      return copy;
    });
  };

  const handleUpdateProposalAuthor = (index: number, newAuthor: string) => {
    setReviewProposals((prev) => {
      if (!prev) return null;
      const copy = [...prev];
      copy[index] = { ...copy[index], proposedAuthor: newAuthor, authorChanged: true };
      return copy;
    });
  };

  const toggleProposalEditing = (index: number) => {
    setReviewProposals((prev) => {
      if (!prev) return null;
      const copy = [...prev];
      copy[index] = { ...copy[index], isEditing: !copy[index].isEditing };
      return copy;
    });
  };

  const toggleSelectAllProposals = () => {
    setReviewProposals((prev) => {
      if (!prev) return null;
      const allSelected = prev.every((p) => p.selected);
      return prev.map((p) => ({ ...p, selected: !allSelected }));
    });
  };

  const handleApplyApprovedProposals = async () => {
    if (!reviewProposals || !onBatchUpdateBooks) return;
    setIsSaving(true);
    try {
      const selectedOnes = reviewProposals.filter((p) => p.selected);
      if (selectedOnes.length === 0) {
        showToast('Chưa chọn cuốn nào để áp dụng.', 'info');
        setIsSaving(false);
        return;
      }

      const updatedList: BookRecord[] = selectedOnes.map((p) => {
        const orig = books.find((b) => b.id === p.bookId);
        const finalSummary = p.summary || orig?.summary || '';
        const finalCover = p.cover_url || orig?.cover_url || '';
        return {
          ...orig,
          id: p.bookId,
          title: p.titleChanged ? p.proposedTitle : (orig?.title || p.originalTitle),
          author: p.authorChanged ? p.proposedAuthor : (orig?.author || p.originalAuthor),
          category: p.category || orig?.category || 'Chung',
          publisher: p.publisher || orig?.publisher || '',
          ...(finalSummary ? { summary: finalSummary } : {}),
          ...(finalCover ? { cover_url: finalCover } : {}),
          is_ai_normalized: true,
          updated_at: Date.now(),
        } as BookRecord;
      });

      await onBatchUpdateBooks(updatedList);
      showToast(`Đã áp dụng tên & tác giả cho ${selectedOnes.length} cuốn!`, 'success');

      // Tự động đúc kết quy tắc, lưu kép LocalStorage + Sheet Config để nạp nóng cho lượt AI tiếp theo
      getAccessToken().then((token) => {
        recordApprovedProposalsAndHotReload(selectedOnes, {
          accessToken: token || undefined,
          spreadsheetId: spreadsheetInfo?.id || undefined,
        });
        // Gửi đóng góp Cloud Firestore khi hoàn thành phiên duyệt
        flushSessionContributionsToCloud().catch(() => {});
      }).catch(() => {
        recordApprovedProposalsAndHotReload(selectedOnes);
        flushSessionContributionsToCloud().catch(() => {});
      });

      setReviewProposals(null);
      setPendingReviewCount(0);
      pendingReviewAccumulatorRef.current = [];
      clearPendingTitleAuthorProposals();
    } catch (err: any) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDismissAllProposals = () => {
    setReviewProposals(null);
    setPendingReviewCount(0);
    pendingReviewAccumulatorRef.current = [];
    clearPendingTitleAuthorProposals();
    showToast('Đã giữ nguyên tên sách & tác giả gốc.', 'info');
    flushSessionContributionsToCloud().catch(() => {});
  };

  const handleResetAiStatus = async () => {
    if (isNormalizing || !onBatchUpdateBooks || books.length === 0) return;
    const now = Date.now();
    const resetList: BookRecord[] = books.map((b) => ({
      ...b,
      is_ai_normalized: false,
      updated_at: now,
    }));
    await onBatchUpdateBooks(resetList);
    pendingReviewAccumulatorRef.current = [];
    setPendingReviewCount(0);
    setCurrentBatchText('');
    clearPendingTitleAuthorProposals();
    console.log(`[Normalize] Đã đặt lại cờ AI (is_ai_normalized=false) cho ${books.length} cuốn sách.`);
    showToast(`Đã đặt lại cờ AI cho ${books.length} cuốn sách! Bấm "Hiệu chỉnh thủ công" để chạy lại.`, 'success', 4000);
  };

  const handleManualDeduplicate = async () => {
    if (!books || books.length === 0) return;
    setIsDeduplicating(true);
    setDedupProgress({ percent: 0, current: 0, total: books.length });
    setDedupScannedCount(0);
    try {
      const ignoredPairs = getLocalIgnoredDuplicatePairs();
      const groups = await groupDuplicateBooksAsync(
        books,
        (percent, current, total) => {
          setDedupProgress({ percent, current, total });
          setDedupScannedCount(current);
        },
        ignoredPairs
      );
      setDedupScannedCount(books.length);
      if (groups.length > 0) {
        const selections: Record<string, string[]> = {};
        groups.forEach((g) => {
          selections[g.id] = [g.books[0].id];
        });
        setDuplicateGroups(groups);
        setSelectedKeepIds(selections);
      } else {
        showToast('Kho sách sạch sẽ, không có sách trùng!', 'success');
      }
    } catch (err: any) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setIsDeduplicating(false);
      setDedupProgress(null);
    }
  };

  const handleConfirmKeepDuplicates = async () => {
    if (!duplicateGroups) return;

    const emptyGroup = duplicateGroups.find((g) => (selectedKeepIds[g.id] || []).length === 0);
    if (emptyGroup) {
      showToast('Mỗi nhóm cần giữ lại ít nhất 1 cuốn!', 'warning');
      return;
    }

    setIsSaving(true);
    try {
      const idsToDelete = new Set<string>();
      const newIgnoredSignatures: string[] = [];

      duplicateGroups.forEach((group) => {
        const keepIds = new Set(selectedKeepIds[group.id] || []);
        const keptBooks = group.books.filter((b) => keepIds.has(b.id));

        // Nếu người dùng chọn giữ từ 2 cuốn trở lên trong nhóm này:
        // Đánh dấu các cặp trong nhóm này là KHÔNG TRÙNG LẶP để không bao giờ bị lọc lại
        if (keptBooks.length > 1) {
          getAccessToken().then((token) => {
            recordKeptDuplicatesAndHotReload(keptBooks, {
              accessToken: token || undefined,
              spreadsheetId: spreadsheetInfo?.id || undefined,
            });
          }).catch(() => {
            recordKeptDuplicatesAndHotReload(keptBooks);
          });

          for (let i = 0; i < keptBooks.length; i++) {
            for (let j = i + 1; j < keptBooks.length; j++) {
              const sigs = getBookPairSignatures(keptBooks[i], keptBooks[j]);
              newIgnoredSignatures.push(...sigs);
            }
          }
        }

        group.books.forEach((book) => {
          if (!keepIds.has(book.id)) {
            idsToDelete.add(book.id);
          }
        });
      });

      // Lưu các cặp đánh dấu bỏ qua vào bộ nhớ máy và đồng bộ lên Google Drive
      if (newIgnoredSignatures.length > 0) {
        const existingLocal = getLocalIgnoredDuplicatePairs();
        const merged = Array.from(new Set([...existingLocal, ...newIgnoredSignatures]));
        saveLocalIgnoredDuplicatePairs(merged);

        try {
          const savedSheetRaw = localStorage.getItem('library_spreadsheet_info_v2');
          if (savedSheetRaw) {
            const sheetInfo = JSON.parse(savedSheetRaw);
            const token = await getAccessToken();
            if (token && sheetInfo?.id) {
              await syncIgnoredDuplicatePairsWithDrive(token, sheetInfo.id, newIgnoredSignatures);
            }
          }
        } catch (syncErr) {
          console.warn('[SettingsModal] syncIgnoredDuplicatePairsWithDrive silent error:', syncErr);
        }
      }

      // Đóng góp quy tắc lên Cloud Firestore khi hoàn tất xử lý danh sách trùng
      flushSessionContributionsToCloud().catch(() => {});

      if (idsToDelete.size === 0) {
        showToast('Đã giữ lại tất cả sách và đánh dấu không phải trùng lặp!', 'success');
        setDuplicateGroups(null);
        return;
      }

      const deleteIdsList = Array.from(idsToDelete);
      if (onBatchDeleteBooks) {
        await onBatchDeleteBooks(deleteIdsList);
      } else {
        const remainingBooks = books.filter((b) => !idsToDelete.has(b.id));
        saveAllLocalBooks(remainingBooks);
        if (onBatchUpdateBooks) {
          await onBatchUpdateBooks(remainingBooks);
        }
      }

      showToast(
        newIgnoredSignatures.length > 0
          ? `Đã xóa ${idsToDelete.size} cuốn trùng & ghi nhớ các cuốn giữ lại!`
          : `Đã xóa ${idsToDelete.size} cuốn trùng!`,
        'success'
      );
      setDuplicateGroups(null);
    } catch (err: any) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const isDuplicateView = Boolean(duplicateGroups && duplicateGroups.length > 0);
  const isReviewView = Boolean(reviewProposals && reviewProposals.length > 0);
  const isExpandedView = isDuplicateView || isReviewView;

  return (
    <div
      className={`fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center ${
        isExpandedView ? 'p-0 sm:p-4' : 'p-3 sm:p-4'
      }`}
      onClick={() => {
        if (duplicateGroups) setDuplicateGroups(null);
        else if (reviewProposals) setReviewProposals(null);
        else onClose();
      }}
    >
      <div
        className={`bg-white shadow-2xl border border-slate-100 overflow-hidden flex flex-col ${
          isExpandedView
            ? 'w-full h-full sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-3xl rounded-none'
            : 'rounded-3xl max-w-md w-full max-h-[88vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - Ocean Blue Brand Style */}
        <div className="px-4 py-3 bg-[#0284C7] text-white flex items-center justify-between shrink-0 border-b border-sky-700">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#10B981] text-white flex items-center justify-center shrink-0 shadow-xs">
              <SettingsIcon className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 className="text-sm font-extrabold text-white leading-tight">
                {isReviewView
                  ? 'Duyệt Đề Xuất Đổi Tên & Tác Giả'
                  : isDuplicateView
                  ? 'Dọn Dẹp Sách Trùng Lặp'
                  : 'Cấu Hình Kho Sách'}
              </h3>
            </div>
          </div>
          <button
            onClick={() => {
              if (duplicateGroups) setDuplicateGroups(null);
              else if (reviewProposals) setReviewProposals(null);
              else onClose();
            }}
            className="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded-xl transition cursor-pointer"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        {reviewProposals ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="px-4 py-2 bg-purple-50 border-b border-purple-100 flex items-center justify-between text-xs shrink-0">
              <span className="text-purple-950 font-bold text-[11px]">
                Duyệt đổi tên: <strong className="text-[#653f96] font-black">{reviewProposals.filter((p) => p.selected).length}</strong>/{reviewProposals.length}
              </span>
              <button
                type="button"
                onClick={toggleSelectAllProposals}
                className="text-[11px] font-bold text-[#653f96] hover:text-purple-900 transition flex items-center gap-1 active:scale-95"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>
                  {reviewProposals.every((p) => p.selected) ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                </span>
              </button>
            </div>

            <div className="p-3.5 space-y-2.5 overflow-y-auto flex-1 bg-slate-50">
              {reviewProposals.map((proposal, idx) => (
                <div
                  key={proposal.bookId}
                  className={`p-3 rounded-2xl border transition-all select-none space-y-2.5 ${
                    proposal.selected
                      ? 'bg-purple-50/70 border-purple-300 shadow-2xs'
                      : 'bg-white border-slate-200 opacity-80 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      onClick={() => toggleProposalSelect(idx)}
                      className="pt-0.5 shrink-0 cursor-pointer"
                    >
                      {proposal.selected ? (
                        <CheckSquare className="w-4.5 h-4.5 text-[#653f96]" />
                      ) : (
                        <Square className="w-4.5 h-4.5 text-slate-400" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0 space-y-2 text-xs">
                      {/* Header: Nút Bật/Tắt Sửa */}
                      <div className="flex items-center justify-end pb-1.5 border-b border-purple-100/60">
                        <button
                          type="button"
                          onClick={() => toggleProposalEditing(idx)}
                          className={`px-2 py-1 rounded-xl text-[10.5px] font-bold transition flex items-center gap-1 shrink-0 cursor-pointer ${
                            proposal.isEditing
                              ? 'bg-[#653f96] text-white shadow-xs'
                              : 'bg-slate-100 hover:bg-purple-100 text-slate-600 hover:text-[#653f96]'
                          }`}
                        >
                          <Pencil className="w-3 h-3" />
                          <span>{proposal.isEditing ? 'Xong' : 'Sửa'}</span>
                        </button>
                      </div>

                      {/* Tên sách */}
                      <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase">Tên sách:</div>
                        {proposal.isEditing ? (
                          <div className="mt-1">
                            <input
                              type="text"
                              value={proposal.proposedTitle}
                              onChange={(e) => handleUpdateProposalTitle(idx, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-full px-2.5 py-1 text-xs font-bold text-[#653f96] bg-white border border-purple-300 focus:border-[#653f96] rounded-xl focus:outline-none transition"
                              placeholder="Nhập tên sách hiệu chỉnh..."
                            />
                          </div>
                        ) : proposal.titleChanged ? (
                          <div className="space-y-1">
                            <div className="text-slate-500 line-through text-[11px] whitespace-normal break-words">{proposal.originalTitle}</div>
                            <div className="text-[#653f96] font-bold flex items-start gap-1">
                              <ArrowRight className="w-3 h-3 text-[#653f96] shrink-0 mt-0.5" />
                              <span className="whitespace-normal break-words">{proposal.proposedTitle}</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-slate-800 font-semibold whitespace-normal break-words">{proposal.originalTitle}</div>
                        )}
                      </div>

                      {/* Tác giả */}
                      {(proposal.authorChanged || proposal.originalAuthor || proposal.isEditing) && (
                        <div className="pt-1.5 border-t border-purple-100/60">
                          <div className="text-[10px] font-bold text-slate-400 uppercase">Tác giả:</div>
                          {proposal.isEditing ? (
                            <div className="mt-1">
                              <input
                                type="text"
                                value={proposal.proposedAuthor}
                                onChange={(e) => handleUpdateProposalAuthor(idx, e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                className="w-full px-2.5 py-1 text-xs font-bold text-[#653f96] bg-white border border-purple-300 focus:border-[#653f96] rounded-xl focus:outline-none transition"
                                placeholder="Nhập tên tác giả hiệu chỉnh..."
                              />
                            </div>
                          ) : proposal.authorChanged ? (
                            <div className="space-y-1">
                              <div className="text-slate-500 line-through text-[11px] whitespace-normal break-words">{proposal.originalAuthor || 'Chưa rõ'}</div>
                              <div className="text-[#653f96] font-bold flex items-start gap-1">
                                <ArrowRight className="w-3 h-3 text-[#653f96] shrink-0 mt-0.5" />
                                <span className="whitespace-normal break-words">{proposal.proposedAuthor}</span>
                              </div>
                            </div>
                          ) : (
                            <div className="text-slate-800 font-semibold whitespace-normal break-words">{proposal.originalAuthor || 'Chưa rõ'}</div>
                          )}
                        </div>
                      )}

                      {/* Nguồn tra cứu */}
                      {proposal.sources.length > 0 && !proposal.isEditing && (
                        <div className="pt-1.5 border-t border-purple-100/60">
                          <div className="text-[10px] font-bold text-slate-400 uppercase">Nguồn tra cứu đối chiếu:</div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                            {proposal.sources.slice(0, 3).map((source) => (
                              <a
                                key={`${source.provider}-${source.url}`}
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 underline"
                              >
                                <ExternalLink className="w-3 h-3" />
                                {source.provider}: {source.title}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                onClick={handleDismissAllProposals}
                className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200/60 rounded-xl transition"
              >
                Bỏ qua
              </button>
              <button
                type="button"
                onClick={handleApplyApprovedProposals}
                disabled={isSaving || reviewProposals.filter((p) => p.selected).length === 0}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-[#653f96] hover:bg-[#52327c] rounded-xl shadow-xs transition disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                <span>Áp dụng ({reviewProposals.filter((p) => p.selected).length})</span>
              </button>
            </div>
          </div>
        ) : duplicateGroups ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="p-3 space-y-2.5 overflow-y-auto flex-1 bg-slate-50/70">
              {duplicateGroups.map((group, groupIdx) => {
                const groupKeepIds = selectedKeepIds[group.id] || [];
                return (
                  <div
                    key={group.id}
                    className="bg-white border border-slate-200/80 rounded-2xl p-3 shadow-3xs space-y-2"
                  >
                    {/* Header nhóm: chỉ giữ lại thứ tự nhóm + số cuốn trùng */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-rose-900 bg-rose-50 border border-rose-100 px-2.5 py-0.5 rounded-lg">
                        Nhóm #{groupIdx + 1} ({group.books.length} cuốn trùng)
                      </span>
                    </div>

                    {/* Danh sách sách trong nhóm để chọn giữ lại */}
                    <div className="space-y-1.5">
                      {group.books.map((book) => {
                        const isSelected = groupKeepIds.includes(book.id);
                        return (
                          <div
                            key={book.id}
                            onClick={() => {
                              setSelectedKeepIds((prev) => {
                                const currentList = prev[group.id] || [];
                                const exists = currentList.includes(book.id);
                                const updated = exists
                                  ? currentList.filter((id) => id !== book.id)
                                  : [...currentList, book.id];
                                return { ...prev, [group.id]: updated };
                              });
                            }}
                            className={`flex items-center gap-2.5 p-2 rounded-xl border transition cursor-pointer select-none ${
                              isSelected
                                ? 'border-[#88284c] bg-rose-50/60 shadow-3xs'
                                : 'border-slate-100 hover:border-slate-200 bg-slate-50/70 opacity-60'
                            }`}
                          >
                            <div className="shrink-0">
                              <div
                                className={`w-4 h-4 rounded-md border flex items-center justify-center transition ${
                                  isSelected
                                    ? 'border-[#88284c] bg-[#88284c] text-white'
                                    : 'border-slate-300 bg-white'
                                }`}
                              >
                                {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                              </div>
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="font-bold text-slate-800 text-xs sm:text-[13px] whitespace-normal break-words leading-relaxed">
                                {book.title}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer Buttons */}
            <div className="px-4 py-3 bg-white border-t border-slate-100 flex gap-2.5 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={() => setDuplicateGroups(null)}
                className="flex-1 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition active:scale-95 cursor-pointer text-center"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleConfirmKeepDuplicates}
                disabled={isSaving}
                className="flex-[2] py-2.5 text-xs font-bold text-white bg-[#88284c] hover:bg-[#6e1e3b] rounded-xl shadow-xs transition active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5 cursor-pointer text-center"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Đang xử lý...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Xác nhận</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="p-4 space-y-3 overflow-y-auto flex-1 bg-slate-50/50">

            {/* 1. GEMINI API KEY CÁ NHÂN (TỰ ĐỘNG THU GỌN / MỞ RỘNG KHI CẦN) */}
            <div className="bg-white rounded-2xl border border-slate-100 p-3 shadow-3xs transition-all duration-200">
              {/* Header: Clickable bar to toggle expand / collapse */}
              <div
                onClick={() => setIsKeySectionExpanded(!isKeySectionExpanded)}
                className="flex items-center justify-between gap-2 cursor-pointer select-none"
              >
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-slate-800 leading-tight">
                      Gemini API Key
                    </span>
                    {apiKeys.length > 0 ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 bg-purple-50 text-[#653f96] border border-purple-200/70 rounded-full">
                        Đã kích hoạt
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200/70 rounded-full">
                        Chưa cấu hình
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition"
                    title={isKeySectionExpanded ? 'Thu gọn' : 'Mở rộng'}
                  >
                    {isKeySectionExpanded ? (
                      <ChevronUp className="w-4 h-4 text-[#653f96]" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                  </button>
                </div>
              </div>

              {/* Nội dung chi tiết (Chỉ hiển thị khi Mở Rộng) */}
              {isKeySectionExpanded && (
                <div className="space-y-2.5 pt-1.5 mt-1 border-t border-slate-100">
                  {/* Ô nhập Key mới - Luôn hiển thị để thêm bao nhiêu tuỳ ý */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10.5px] font-bold text-slate-500">
                        Thêm Key (dán từng key hoặc nhiều key cách nhau dấu phẩy)
                      </span>
                      <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-bold text-[#653f96] hover:underline flex items-center gap-0.5 shrink-0"
                      >
                        <span>Lấy Key</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                    <form
                      role="search"
                      onSubmit={(e) => e.preventDefault()}
                      autoComplete="off"
                      className="flex gap-1.5"
                    >
                      <div className="relative flex-1">
                        <input
                          type="text"
                          name="nomatch_key"
                          id="book-api-input-search"
                          autoComplete="new-password"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          inputMode="text"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-form-type="other"
                          value={newKeyInput}
                          onChange={(e) => setNewKeyInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && newKeyInput.trim()) {
                              e.preventDefault();
                              handleAddKey();
                            }
                          }}
                          placeholder="Dán 1 hoặc nhiều Key (cách nhau dấu phẩy)..."
                          className="w-full px-3 py-1.5 text-xs bg-slate-50 focus:bg-white border border-slate-200 focus:border-[#653f96] rounded-xl focus:ring-2 focus:ring-[#653f96]/20 focus:outline-none transition font-medium text-slate-800"
                        />
                        {newKeyInput && (
                          <button
                            type="button"
                            onClick={() => setNewKeyInput('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-full bg-slate-200/60 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={handleAddKey}
                        disabled={!newKeyInput.trim()}
                        className="px-3.5 py-1.5 bg-[#653f96] hover:bg-[#52327c] text-white text-xs font-bold rounded-xl transition disabled:opacity-40 cursor-pointer shrink-0"
                      >
                        Thêm
                      </button>
                    </form>
                  </div>

                  {/* Danh sách các Keys đã lưu */}
                  {apiKeys.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-dashed border-slate-100">
                      <div className="flex items-center justify-between px-0.5">
                        <span className="text-[10px] text-slate-400 font-bold">
                          Đã lưu ({apiKeys.length}):
                        </span>
                        <button
                          type="button"
                          onClick={handleTestAllKeys}
                          disabled={apiKeys.some((k) => testingKeysMap[k])}
                          className="text-[10px] font-bold text-[#653f96] hover:text-[#52327c] disabled:opacity-50 cursor-pointer"
                        >
                          Test tất cả
                        </button>
                      </div>
                      <div className="max-h-36 overflow-y-auto space-y-1 pr-0.5">
                        {apiKeys.map((key, idx) => {
                          const testing = testingKeysMap[key] || false;
                          const result = testResultsMap[key];
                          const masked = `${key.slice(0, 6)}••••••••${key.slice(-4)}`;

                          return (
                            <div key={key} className="bg-slate-50 border border-slate-200/70 rounded-xl px-2.5 py-1.5 space-y-1 transition">
                              <div className="flex items-center justify-between gap-1.5">
                                <span className="font-mono text-slate-700 text-[10.5px] font-semibold truncate flex-1 min-w-0">
                                  #{idx + 1}: {masked}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleTestSingleKey(key);
                                    }}
                                    disabled={testing}
                                    title={
                                      testing
                                        ? 'Đang kiểm tra key...'
                                        : result?.success === true
                                        ? 'Key hoạt động tốt (Bấm để thử lại)'
                                        : result?.success === false
                                        ? `Lỗi: ${result.message || 'Không hợp lệ'} (Bấm để thử lại)`
                                        : 'Bấm để kiểm tra key'
                                    }
                                    className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition active:scale-95 disabled:opacity-60 flex items-center gap-1 cursor-pointer ${
                                      testing
                                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                        : result?.success === true
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-emerald-100'
                                        : result?.success === false
                                        ? 'bg-rose-50 text-rose-700 border border-rose-300 hover:bg-rose-100'
                                        : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'
                                    }`}
                                  >
                                    {testing ? (
                                      <>
                                        <Loader2 className="w-2.5 h-2.5 animate-spin text-amber-600" />
                                        <span>Thử...</span>
                                      </>
                                    ) : result?.success === true ? (
                                      <>
                                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                                        <span>OK</span>
                                      </>
                                    ) : result?.success === false ? (
                                      <>
                                        <XCircle className="w-2.5 h-2.5 text-rose-600" />
                                        <span>Lỗi</span>
                                      </>
                                    ) : (
                                      <span>Test</span>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteKey(key);
                                    }}
                                    title="Xóa Key này"
                                    className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition active:scale-95 cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                              {result?.success === false && result.message && (
                                <p className="text-[10px] text-rose-600 font-medium leading-tight">
                                  {result.message}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 2. DỌN SÁCH TRÙNG LẶP */}
            <div className="bg-emerald-50/40 rounded-2xl border border-emerald-100/60 p-3.5 shadow-3xs flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0 flex-1">
                <span className="text-xs font-black text-slate-800 block leading-tight">
                  Dọn sách trùng lặp
                </span>
                <span className="text-xs font-bold text-slate-500 block leading-tight">
                  {isDeduplicating && dedupProgress
                    ? `${dedupProgress.current}/${dedupProgress.total} cuốn`
                    : `${dedupScannedCount}/${totalBooks} cuốn`}
                </span>
              </div>

              <button
                type="button"
                onClick={handleManualDeduplicate}
                disabled={isDeduplicating || books.length === 0}
                className="px-3.5 py-2 bg-[#EA580C] hover:bg-[#c2410c] text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5 shrink-0 disabled:opacity-50 active:scale-95 cursor-pointer shadow-xs"
              >
                {isDeduplicating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{dedupProgress ? `${dedupProgress.percent}%` : 'Đang quét...'}</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Dọn ngay</span>
                  </>
                )}
              </button>
            </div>

            {/* 3. HIỆU CHỈNH KHO SÁCH */}
            <div className="bg-white rounded-2xl border border-slate-100 p-3.5 space-y-3 shadow-3xs">
              <div className="flex items-center justify-between gap-2">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-xs font-black text-slate-800 block leading-tight">
                    Hiệu chỉnh kho sách
                  </span>
                </div>

                <div className="px-3 py-1 bg-purple-50 text-[#653f96] text-xs font-extrabold rounded-xl shrink-0 text-center leading-tight">
                  {normalizedCount}/{totalBooks}
                </div>
              </div>

              {/* Hàng: AI tự động với nút gạt Switch */}
              <div className="p-2 px-3 bg-white border border-purple-100/90 rounded-xl flex items-center justify-between shadow-3xs">
                <span className="text-xs font-bold text-slate-800">
                  AI tự động
                </span>
                <button
                  type="button"
                  onClick={() => handleToggleAutoNormalize(!autoNormalize)}
                  className={`w-10 h-5.5 flex items-center rounded-full p-0.5 transition-colors cursor-pointer ${
                    autoNormalize ? 'bg-[#8233ff]' : 'bg-slate-300'
                  }`}
                >
                  <div
                    className={`bg-white w-4.5 h-4.5 rounded-full shadow-md transform transition-transform ${
                      autoNormalize ? 'translate-x-4.5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Chọn các trường thông tin được hiệu chỉnh */}
              <div className="p-2.5 bg-slate-50 border border-purple-100/70 rounded-xl space-y-1.5 shadow-3xs">
                <div className="flex items-center justify-between text-[11px] font-bold text-slate-700">
                  <span>Trường hiệu chỉnh ({selectedNormalizeFields.length}/6):</span>
                  <button
                    type="button"
                    onClick={async () => {
                      const allKeys = NORMALIZE_FIELD_OPTIONS.map((f) => f.key);
                      const updated = selectedNormalizeFields.length === allKeys.length
                        ? (['category', 'summary'] as NormalizeFieldKey[])
                        : allKeys;
                      setSelectedNormalizeFields(updated);
                      await onSaveSettings({ ...settings, normalizeFields: updated });
                    }}
                    className="text-[10px] text-[#653f96] hover:underline cursor-pointer font-bold"
                  >
                    {selectedNormalizeFields.length === NORMALIZE_FIELD_OPTIONS.length ? 'Rút gọn' : 'Chọn tất cả'}
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {NORMALIZE_FIELD_OPTIONS.map((field) => {
                    const isChecked = selectedNormalizeFields.includes(field.key);
                    return (
                      <button
                        key={field.key}
                        type="button"
                        onClick={() => handleToggleNormalizeField(field.key)}
                        className={`flex items-center gap-1.5 py-1.5 px-2 rounded-lg border text-[11px] transition active:scale-95 cursor-pointer select-none ${
                          isChecked
                            ? 'bg-purple-50 text-[#653f96] border-purple-300 shadow-3xs font-bold'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 font-medium'
                        }`}
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] shrink-0 transition ${
                            isChecked ? 'bg-[#653f96] text-white' : 'border border-slate-300 bg-white'
                          }`}
                        >
                          {isChecked && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                        </div>
                        <span className="truncate">{field.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Progress: Tiến độ: 100% !X */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-700">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-semibold">Tiến độ: </span>
                    <span className="font-bold text-[#653f96]">
                      {Math.round((normalizedCount / (totalBooks || 1)) * 100)}%
                    </span>
                    {activeReviewCount > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const currentProposals = pendingReviewAccumulatorRef.current.length > 0
                            ? pendingReviewAccumulatorRef.current
                            : loadPendingTitleAuthorProposals();
                          if (currentProposals.length > 0) {
                            setReviewProposals([...currentProposals]);
                          }
                        }}
                        title={`${activeReviewCount} cuốn sách cần duyệt đổi tên/tác giả (Bấm để xem)`}
                        className="px-2 py-0.5 rounded-lg bg-rose-50 border border-rose-200 text-[11px] font-black text-rose-600 hover:bg-rose-100 transition cursor-pointer"
                      >
                        !{activeReviewCount} Chờ duyệt
                      </button>
                    )}
                  </div>
                  {currentBatchText && (
                    <span className="text-[11px] font-medium text-[#653f96] truncate">
                      {currentBatchText}
                    </span>
                  )}
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#8233ff] transition-all duration-300 rounded-full"
                    style={{ width: `${Math.round((normalizedCount / (totalBooks || 1)) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Bottom: Hàng nút thao tác cân đối */}
              <div className="space-y-2 pt-1.5 border-t border-slate-100">
                <div className="flex items-center gap-1.5">
                  {isNormalizing ? (
                    <button
                      type="button"
                      onClick={handleStopNormalize}
                      className="flex-1 h-9 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shadow-3xs whitespace-nowrap min-w-0"
                    >
                      <Pause className="w-3.5 h-3.5 shrink-0" />
                      <span>Dừng</span>
                    </button>
                  ) : !autoNormalize ? (
                    <button
                      type="button"
                      onClick={handleStartNormalize}
                      className={`flex-1 h-9 px-3 bg-[#8233ff] hover:bg-[#6f24e6] text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shadow-3xs whitespace-nowrap min-w-0 ${
                        pendingBooks.length === 0 ? 'opacity-65' : ''
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {pendingBooks.length > 0 && pendingBooks.length < totalBooks
                          ? `Hiệu chỉnh thủ công (${pendingBooks.length})`
                          : 'Hiệu chỉnh thủ công'}
                      </span>
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={handleResetAiStatus}
                    disabled={isNormalizing || books.length === 0}
                    className={`${
                      !autoNormalize || isNormalizing ? 'px-2.5 shrink-0' : 'w-full'
                    } h-9 bg-purple-50 hover:bg-purple-100 disabled:opacity-40 text-[#653f96] border border-purple-200/60 text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer flex items-center justify-center gap-1 whitespace-nowrap`}
                    title="Đặt lại trạng thái để hiệu chỉnh lại từ đầu"
                  >
                    <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                    <span>Làm lại</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 4. XÓA DỮ LIỆU SÁCH TRÊN MÁY */}
            <div className="bg-rose-50/50 rounded-2xl border border-rose-100/80 p-3.5 shadow-3xs flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0 flex-1">
                <span className="text-xs font-black text-rose-900 block leading-tight">
                  Xóa dữ liệu trên máy
                </span>
              </div>

              <button
                type="button"
                onClick={() => setShowClearConfirm(true)}
                disabled={books.length === 0}
                className="px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5 shrink-0 disabled:opacity-50 active:scale-95 cursor-pointer shadow-xs"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa tất cả</span>
              </button>
            </div>

            {/* 5. PHIÊN BẢN */}
            <div className="bg-white rounded-2xl border border-slate-100 p-3.5 shadow-3xs flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0 flex-1">
                <span className="text-xs font-black text-slate-800 block leading-tight">
                  Phiên bản
                </span>
                <span className="text-[11px] text-slate-500 block leading-tight font-medium">
                  v{CURRENT_APP_VERSION}
                </span>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const res = await downloadLogs(CURRENT_APP_VERSION);
                    showToast(res.message, res.success ? 'success' : 'error');
                  }}
                  className="px-3.5 py-2 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition flex items-center gap-1.5 shrink-0 cursor-pointer shadow-xs active:scale-95"
                >
                  <span>Tải log</span>
                </button>
                {onCheckUpdates && (
                  <button
                    type="button"
                    onClick={onCheckUpdates}
                    className="px-3.5 py-2 text-xs font-bold text-white bg-[#0284C7] hover:bg-[#0369a1] rounded-xl transition flex items-center gap-1.5 shrink-0 cursor-pointer shadow-xs active:scale-95"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Cập nhật</span>
                  </button>
                )}
              </div>

            </div>

            </div>

            {/* Footer Actions */}
            <div className="px-4 py-3 bg-white border-t border-slate-100 flex items-center justify-end gap-2.5 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer text-center"
              >
                Đóng
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 px-4 bg-[#EA580C] hover:bg-[#c2410c] text-white text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer text-center shadow-xs flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>Lưu</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* POPUP NATIVE XÁC NHẬN XÓA TẤT CẢ SÁCH (ĐƠN GIẢN, GỌN GÀNG) */}
      {showClearConfirm && (
        <div
          className="fixed inset-0 z-60 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={() => setShowClearConfirm(false)}
        >
          <div
            className="w-full max-w-xs bg-white rounded-3xl shadow-2xl border border-slate-100 p-5 space-y-4 text-center transform animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 border border-rose-100 flex items-center justify-center mx-auto shadow-3xs">
              <Trash2 className="w-6 h-6" />
            </div>

            <div className="space-y-1">
              <h3 className="text-sm font-black text-slate-900">
                Xóa tất cả sách trên máy?
              </h3>
              <p className="text-xs text-slate-500 leading-normal">
                Toàn bộ <strong className="text-rose-600 font-bold">{books.length} cuốn</strong> sẽ được xóa khỏi thiết bị. Dữ liệu trên Google Sheet vẫn an toàn.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowClearConfirm(false);
                  if (onClearLocalBooksOnly) {
                    await onClearLocalBooksOnly();
                  }
                }}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer shadow-xs"
              >
                Xác nhận xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
