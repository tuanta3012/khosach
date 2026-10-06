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
  Cloud,
  HardDrive,
  Users,
  LogIn,
  LogOut,
  Sliders,
  Filter,
  AlertTriangle,
  ArrowUpCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { LibrarySettings, BookRecord, AuthUser, BookSource } from '../types';
import { useToast } from '../context/ToastContext';
import { CURRENT_APP_VERSION } from '../version';
import { batchNormalize } from '../utils/geminiService';
import {
  getStoredGeminiApiKeys,
  saveStoredGeminiApiKeys,
  testGeminiApiKey,
  getDynamicApiQuotaMetrics,
} from '../services/geminiService';
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
} from '../services/driveSyncService';
import { getAccessToken } from '../services/googleAuthService';
import { saveAllLocalBooks } from '../utils/localBooksStorage';

export interface TitleAuthorProposal {
  bookId: string;
  originalTitle: string;
  proposedTitle: string;
  titleChanged: boolean;
  originalAuthor: string;
  proposedAuthor: string;
  authorChanged: boolean;
  category: string;
  publisher?: string;
  sources: BookSource[];
  selected: boolean;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LibrarySettings;
  onSaveSettings: (newSettings: LibrarySettings) => Promise<void>;
  onCheckUpdates?: () => void;
  books?: BookRecord[];
  onBatchUpdateBooks?: (updatedBooksList: BookRecord[]) => Promise<void>;
  onBatchDeleteBooks?: (idsToDelete: string[]) => Promise<void>;
  onClearLocalBooksOnly?: () => Promise<void>;
  isAutoNormalizing?: boolean;
  appMode?: 'offline' | 'online';
  onSwitchMode?: () => void;
  onOpenFamilyShare?: () => void;
  currentUser?: AuthUser | null;
  onGoogleSignIn?: () => Promise<void>;
  onGoogleLogout?: () => Promise<void>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onCheckUpdates,
  books = [],
  onBatchUpdateBooks,
  onBatchDeleteBooks,
  onClearLocalBooksOnly,
  appMode = 'offline',
  onSwitchMode,
  onOpenFamilyShare,
  currentUser,
  onGoogleSignIn,
  onGoogleLogout,
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
  const pendingReviewAccumulatorRef = useRef<TitleAuthorProposal[]>([]);
  const sourceLookupWarningsRef = useRef(new Set<string>());

  // States cho chuẩn hóa bằng AI
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [currentBatchText, setCurrentBatchText] = useState('');
  const [, setProcessedCount] = useState(0);
  const stopNormalizingRef = useRef(false);

  const totalBooks = books.length;
  const normalizedCount = books.filter((b) => b.is_ai_normalized).length;
  const pendingBooks = books.filter((b) => !b.is_ai_normalized);

  // Mặc định tính năng AI tự động luôn là OFF khi cài app mới
  const [autoNormalize, setAutoNormalize] = useState<boolean>(() => !!settings.autoNormalizeEnabled);

  useEffect(() => {
    setAutoNormalize(!!settings.autoNormalizeEnabled);
  }, [settings.autoNormalizeEnabled, isOpen]);

  const handleToggleAutoNormalize = async (val: boolean) => {
    setAutoNormalize(val);
    await onSaveSettings({ ...settings, autoNormalizeEnabled: val });
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
    return getCleanKeys().length === 0;
  });
  
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    return getCleanKeys();
  });

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
          showToast('API Key hoạt động tốt (OK)!', 'success');
        } else {
          showToast(`Lỗi Key: ${res.message || 'Không thể kết nối'}`, 'error');
        }
      }
    } catch (err: any) {
      setTestResultsMap((prev) => ({
        ...prev,
        [clean]: { success: false, message: err?.message || 'Lỗi kết nối mạng.' },
      }));
      if (!silentToast) {
        showToast(`Lỗi Key: ${err?.message || 'Lỗi kết nối'}`, 'error');
      }
    } finally {
      setTestingKeysMap((prev) => ({ ...prev, [clean]: false }));
    }
  };

  const handleAddKey = async () => {
    const clean = newKeyInput.trim();
    if (!clean) return;
    if (apiKeys.includes(clean)) {
      showToast('API Key này đã tồn tại trong danh sách!', 'warning');
      return;
    }
    const updatedKeys = [...apiKeys, clean];
    saveStoredGeminiApiKeys(updatedKeys);
    await onSaveSettings({ ...settings, geminiApiKeys: updatedKeys });
    setApiKeys(updatedKeys);
    setNewKeyInput(''); // Xóa trắng ô gõ phím sau khi hoàn thành
    
    // Tự động kiểm tra ngay lập tức khi vừa nhập xong
    handleTestSingleKey(clean);
  };

  const handleDeleteKey = async (keyToDelete: string) => {
    const updatedKeys = apiKeys.filter((k) => k !== keyToDelete);
    saveStoredGeminiApiKeys(updatedKeys);
    await onSaveSettings({ ...settings, geminiApiKeys: updatedKeys });
    setApiKeys(updatedKeys);
    showToast('Đã xóa Gemini API Key!', 'info');
  };

  if (!isOpen) return null;

  const handleStartNormalize = async () => {
    if (!onBatchUpdateBooks || pendingBooks.length === 0) return;

    // Đảm bảo đồng bộ API Keys vào storage trước khi chạy
    let storedKeys = getStoredGeminiApiKeys();
    if (storedKeys.length === 0 && apiKeys.length > 0) {
      saveStoredGeminiApiKeys(apiKeys);
      storedKeys = getStoredGeminiApiKeys();
    }

    if (storedKeys.length === 0) {
      showToast('Vui lòng thêm và lưu ít nhất 1 Gemini API Key trước khi hiệu chỉnh kho!', 'warning');
      return;
    }

    setIsNormalizing(true);
    stopNormalizingRef.current = false;
    pendingReviewAccumulatorRef.current = [];
    sourceLookupWarningsRef.current.clear();
    let localPending = [...pendingBooks];
    let currentProcessed = 0;

    setCurrentBatchText(`Đang kết nối Gemini API để chuẩn hóa...`);

    const onChunkComplete = async (normalizedChunk: any[], remaining: number) => {
      if (!normalizedChunk || normalizedChunk.length === 0) return;

      const safeUpdatedList: BookRecord[] = [];

      normalizedChunk.forEach((normItem: any) => {
        if (normItem.sourceWarning) sourceLookupWarningsRef.current.add(normItem.sourceWarning);
        const orig = pendingBooks.find((b) => b.id === normItem.id);
        if (!orig) return;

        const normTitleTrim = String(normItem.title || '').trim();
        const origTitleTrim = (orig.title || '').trim();
        const normAuthorTrim = String(normItem.author || '').trim();
        const origAuthorTrim = (orig.author || '').trim();

        // Dùng hàm kiểm tra ngữ nghĩa thông minh: bỏ qua khác biệt về hoa thường, định dạng dấu gạch/phẩy, lỗi chính tả nhẹ
        const titleMeaningfullyChanged = isMeaningfulChange(origTitleTrim, normTitleTrim, false);
        const authorMeaningfullyChanged = isMeaningfulChange(origAuthorTrim, normAuthorTrim, true);

        const enrichedCategory = normItem.category || orig.category || 'Chung';
        const enrichedPublisher = normItem.publisher || orig.publisher || '';

        // Nếu chỉ là làm đẹp / sửa chính tả nhẹ / định dạng -> Tự động áp dụng ngay vào bản ghi
        const resolvedTitle = titleMeaningfullyChanged ? orig.title : (normTitleTrim || orig.title);
        const resolvedAuthor = authorMeaningfullyChanged ? orig.author : (normAuthorTrim || orig.author);

        safeUpdatedList.push({
          ...orig,
          title: resolvedTitle,
          author: resolvedAuthor,
          publisher: enrichedPublisher,
          category: enrichedCategory,
          is_ai_normalized: true,
          updated_at: Date.now(),
        });

        // Chỉ khi có thay đổi ngữ nghĩa lớn (đổi hẳn sang tác phẩm khác / tác giả khác) mới đưa vào danh sách duyệt
        if (titleMeaningfullyChanged || authorMeaningfullyChanged) {
          pendingReviewAccumulatorRef.current.push({
            bookId: orig.id,
            originalTitle: orig.title,
            proposedTitle: normTitleTrim,
            titleChanged: titleMeaningfullyChanged,
            originalAuthor: orig.author,
            proposedAuthor: normAuthorTrim,
            authorChanged: authorMeaningfullyChanged,
            category: enrichedCategory,
            publisher: enrichedPublisher,
            sources: normItem.sources || [],
            selected: true,
          });
        }
      });

      if (safeUpdatedList.length > 0) {
        await onBatchUpdateBooks(safeUpdatedList);
        currentProcessed += safeUpdatedList.length;
        setProcessedCount(currentProcessed);
      }

      setCurrentBatchText(
        remaining > 0
          ? `Đang chuẩn hóa tuần tự: còn ${remaining} cuốn...`
          : `Đang hoàn tất...`
      );
    };

    try {
      const res = await batchNormalize(localPending, {
        onChunkComplete,
        stopSignal: stopNormalizingRef,
        categories: settings.categoriesList,
        withSources: true,
      });
      const sourceWarning = sourceLookupWarningsRef.current.size > 0
        ? ' Một số lượt tra cứu nguồn thất bại; các đề xuất đó không có nguồn để đối chiếu.'
        : '';

      if (res.normalized.length > 0 && res.failedChunks.length > 0) {
        const failedBookCount = res.failedChunks.reduce((count, chunk) => count + chunk.bookIds.length, 0);
        showToast(`Đã hiệu chỉnh ${currentProcessed} cuốn; ${failedBookCount} cuốn chưa xử lý và có thể chạy lại thủ công.${sourceWarning}`, 'warning');
      } else if (currentProcessed > 0 && res.success) {
        showToast(`Đã hoàn tất hiệu chỉnh ${currentProcessed} cuốn sách!${sourceWarning}`, sourceWarning ? 'warning' : 'success');
      } else if (res.stopped && currentProcessed > 0) {
        showToast(`Đã dừng sau khi hiệu chỉnh ${currentProcessed} cuốn sách.${sourceWarning}`, 'info');
      } else if (!stopNormalizingRef.current) {
        const failure = res.failedChunks[0]?.message;
        showToast(failure
          ? `Không thể hiệu chỉnh ${res.failedChunks.reduce((count, chunk) => count + chunk.bookIds.length, 0)} cuốn: ${failure}.${sourceWarning}`
          : `Không có sách nào được chuẩn hóa. Vui lòng kiểm tra lại API Key hoặc hạn ngạch!${sourceWarning}`, 'warning');
      }
    } catch (err: any) {
      console.error('Lỗi khi chuẩn hóa lô:', err);
      showToast(`Lỗi chuẩn hóa: ${err?.message || String(err)}`, 'error');
    }

    setIsNormalizing(false);
    setCurrentBatchText('');
    setProcessedCount(0);

    // Nếu người dùng đã bấm dừng
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
    }
  };

  const handleStopNormalize = () => {
    stopNormalizingRef.current = true;
    setIsNormalizing(false);
    setCurrentBatchText('');
  };

  const toggleProposalSelect = (index: number) => {
    setReviewProposals((prev) => {
      if (!prev) return null;
      const copy = [...prev];
      copy[index] = { ...copy[index], selected: !copy[index].selected };
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
        return {
          ...orig,
          id: p.bookId,
          title: p.titleChanged ? p.proposedTitle : (orig?.title || p.originalTitle),
          author: p.authorChanged ? p.proposedAuthor : (orig?.author || p.originalAuthor),
          category: p.category || orig?.category || 'Chung',
          publisher: p.publisher || orig?.publisher || '',
          is_ai_normalized: true,
          updated_at: Date.now(),
        } as BookRecord;
      });

      await onBatchUpdateBooks(updatedList);
      showToast(`Đã áp dụng tên & tác giả cho ${selectedOnes.length} cuốn!`, 'success');
      setReviewProposals(null);
    } catch (err: any) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDismissAllProposals = () => {
    setReviewProposals(null);
    showToast('Đã giữ nguyên tên sách & tác giả gốc.', 'info');
  };

  const handleResetAiStatus = async () => {
    if (!onBatchUpdateBooks || books.length === 0) return;
    const resetList: BookRecord[] = books.map((b) => ({
      ...b,
      is_ai_normalized: false,
    }));
    await onBatchUpdateBooks(resetList);
    showToast(`Đã đặt lại cờ AI cho ${books.length} cuốn sách!`, 'success');
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

  return (
    <div
      className={`fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center ${
        isDuplicateView ? 'p-0 sm:p-4' : 'p-3 sm:p-4'
      }`}
      onClick={() => {
        if (duplicateGroups) setDuplicateGroups(null);
        else onClose();
      }}
    >
      <div
        className={`bg-white shadow-2xl border border-slate-100 overflow-hidden flex flex-col ${
          isDuplicateView
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
                {isDuplicateView ? 'Dọn Dẹp Sách Trùng Lặp' : 'Cấu Hình Kho Sách'}
              </h3>
            </div>
          </div>
          <button
            onClick={() => {
              if (duplicateGroups) setDuplicateGroups(null);
              else if (reviewProposals) setReviewProposals(null);
              else onClose();
            }}

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
                  onClick={() => toggleProposalSelect(idx)}
                  className={`p-3 rounded-2xl border transition-all cursor-pointer select-none space-y-2 ${
                    proposal.selected
                      ? 'bg-purple-50/70 border-purple-300 shadow-2xs'
                      : 'bg-white border-slate-200 opacity-70 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="pt-0.5 shrink-0">
                      {proposal.selected ? (
                        <CheckSquare className="w-4.5 h-4.5 text-[#653f96]" />
                      ) : (
                        <Square className="w-4.5 h-4.5 text-slate-400" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0 space-y-1 text-xs">
                      <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase">Tên sách:</div>
                        {proposal.titleChanged ? (
                          <div className="space-y-0.5">
                            <div className="text-slate-500 line-through text-[11px]">{proposal.originalTitle}</div>
                            <div className="text-[#653f96] font-bold flex items-center gap-1">
                              <ArrowRight className="w-3 h-3 text-[#653f96] shrink-0" />
                              <span>{proposal.proposedTitle}</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-slate-800 font-semibold">{proposal.originalTitle}</div>
                        )}
                      </div>

                      {proposal.authorChanged && (
                        <div className="pt-1 border-t border-purple-100">
                          <div className="text-[10px] font-bold text-slate-400 uppercase">Tác giả:</div>
                          <div className="space-y-0.5">
                            <div className="text-slate-500 line-through text-[11px]">{proposal.originalAuthor || 'Chưa rõ'}</div>
                            <div className="text-[#653f96] font-bold flex items-center gap-1">
                              <ArrowRight className="w-3 h-3 text-[#653f96] shrink-0" />
                              <span>{proposal.proposedAuthor}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {proposal.sources.length > 0 && (
                        <div className="pt-1 border-t border-purple-100">
                          <div className="text-[10px] font-bold text-slate-400 uppercase">Nguồn tra cứu (đối chiếu trước khi áp dụng):</div>
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
                            <div className="min-w-0 flex-1 flex items-baseline justify-between gap-2">
                              <span className="font-bold text-slate-800 text-xs sm:text-[13px] truncate leading-tight">
                                {book.title}
                              </span>
                              {book.author && (
                                <span className="text-slate-400 text-[10.5px] shrink-0 truncate max-w-[130px] leading-tight">
                                  {book.author}
                                </span>
                              )}
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
                <div className="space-y-2 pt-1.5 mt-1 border-t border-slate-100">
                  {/* Ô nhập Key mới - Luôn hiển thị để thêm bao nhiêu tuỳ ý */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10.5px] font-bold text-slate-500">Thêm API Key mới</span>
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
                          type="search"
                          name="nomatch_key"
                          id="book-api-input-search"
                          autoComplete="new-password"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          inputMode="search"
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
                          placeholder="Dán mã API mới..."
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
                      <div className="text-[10px] text-slate-400 font-bold px-0.5">
                        Danh sách Key đã lưu ({apiKeys.length}):
                      </div>
                      <div className="max-h-28 overflow-y-auto space-y-1 pr-0.5">
                        {apiKeys.map((key, idx) => {
                          const testing = testingKeysMap[key] || false;
                          const result = testResultsMap[key];
                          const masked = `${key.slice(0, 6)}••••••••${key.slice(-4)}`;

                          return (
                            <div key={key} className="bg-slate-50 border border-slate-200/70 rounded-xl px-2.5 py-1.5 flex items-center justify-between gap-1.5 transition">
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

              {/* Progress: Tiến độ: 100% */}
              <div className="space-y-1.5">
                <div className="text-xs text-slate-700">
                  <span className="font-semibold">Tiến độ: </span>
                  <span className="font-bold text-[#653f96]">
                    {Math.round((normalizedCount / (totalBooks || 1)) * 100)}%
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#8233ff] transition-all duration-300 rounded-full"
                    style={{ width: `${Math.round((normalizedCount / (totalBooks || 1)) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Bottom: Trạng thái & Hàng nút thao tác cân đối */}
              <div className="space-y-2 pt-1.5 border-t border-slate-100">
                {isNormalizing && currentBatchText ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[11.5px] font-semibold text-[#653f96] bg-purple-50/90 px-2.5 py-1.5 rounded-xl border border-purple-100 flex items-center justify-between shadow-3xs">
                      <div className="flex items-center gap-1.5 truncate">
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-[#8233ff]" />
                        <span className="truncate">{currentBatchText}</span>
                      </div>
                      {pendingReviewAccumulatorRef.current.length > 0 && (
                        <span className="font-black text-amber-600 shrink-0">
                          !{pendingReviewAccumulatorRef.current.length}
                        </span>
                      )}
                    </div>
                  </div>
                ) : null}

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
                      disabled={pendingBooks.length === 0}
                      className="flex-1 h-9 px-3 bg-[#8233ff] hover:bg-[#6f24e6] disabled:opacity-40 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shadow-3xs whitespace-nowrap min-w-0"
                    >
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      <span>Hiệu chỉnh thủ công</span>
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={handleResetAiStatus}
                    className={`${
                      !autoNormalize || isNormalizing ? 'px-2.5 shrink-0' : 'w-full'
                    } h-9 bg-purple-50 hover:bg-purple-100 text-[#653f96] border border-purple-200/60 text-xs font-bold rounded-xl transition active:scale-95 cursor-pointer flex items-center justify-center gap-1 whitespace-nowrap`}
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
                  Xóa dữ liệu sách trên máy
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

            {/* 5. PHIÊN BẢN ỨNG DỤNG */}
            <div className="bg-white rounded-2xl border border-slate-100 p-3.5 shadow-3xs flex items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0 flex-1">
                <span className="text-xs font-black text-slate-800 block leading-tight">
                  Phiên bản ứng dụng
                </span>
                <span className="text-[11px] text-slate-500 block leading-tight">
                  Bản hiện tại: <strong className="text-slate-800 font-bold">v{CURRENT_APP_VERSION}</strong>
                </span>
              </div>

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
                <span>Lưu Cấu Hình</span>
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
