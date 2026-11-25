import { BookSource } from '../types';

export interface TitleAuthorProposal {
  bookId: string;
  originalTitle: string;
  proposedTitle: string;
  titleChanged: boolean;
  originalAuthor: string;
  proposedAuthor: string;
  authorChanged: boolean;
  category: string;
  publisher: string;
  summary?: string;
  cover_url?: string;
  sources: BookSource[];
  selected: boolean;
  isEditing?: boolean;
}

const PENDING_REVIEW_STORAGE_KEY = 'pending_ai_title_author_reviews_v1';
export const PENDING_REVIEWS_CHANGED_EVENT = 'pending-ai-reviews-changed';

function dispatchReviewsChanged(count: number): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(PENDING_REVIEWS_CHANGED_EVENT, { detail: { count } })
    );
  }
}

export function loadPendingTitleAuthorProposals(): TitleAuthorProposal[] {
  try {
    const raw = localStorage.getItem(PENDING_REVIEW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is TitleAuthorProposal =>
        Boolean(item && typeof item === 'object' && typeof item.bookId === 'string' && item.bookId)
    );
  } catch {
    return [];
  }
}

export function savePendingTitleAuthorProposals(
  proposals: TitleAuthorProposal[]
): TitleAuthorProposal[] {
  const deduped = new Map<string, TitleAuthorProposal>();
  for (const item of proposals) {
    if (!item || !item.bookId) continue;
    deduped.set(item.bookId, item);
  }
  const cleanList = Array.from(deduped.values());
  try {
    if (cleanList.length > 0) {
      localStorage.setItem(PENDING_REVIEW_STORAGE_KEY, JSON.stringify(cleanList));
    } else {
      localStorage.removeItem(PENDING_REVIEW_STORAGE_KEY);
    }
  } catch (err) {
    console.warn('[PendingReviews] Không thể lưu danh sách chờ duyệt:', err);
  }
  dispatchReviewsChanged(cleanList.length);
  return cleanList;
}

export function upsertPendingTitleAuthorProposals(
  newItems: TitleAuthorProposal[]
): TitleAuthorProposal[] {
  if (!newItems || newItems.length === 0) {
    return loadPendingTitleAuthorProposals();
  }
  const existing = loadPendingTitleAuthorProposals();
  const byId = new Map(existing.map((item) => [item.bookId, item]));
  for (const item of newItems) {
    if (!item || !item.bookId) continue;
    if (!byId.has(item.bookId)) {
      byId.set(item.bookId, item);
    } else {
      const prev = byId.get(item.bookId)!;
      byId.set(item.bookId, {
        ...prev,
        ...item,
        cover_url: item.cover_url || prev.cover_url || '',
        selected: prev.selected,
      });
    }
  }
  return savePendingTitleAuthorProposals(Array.from(byId.values()));
}

export function updatePendingProposalCovers(
  coverByBookId: Map<string, string>
): TitleAuthorProposal[] {
  if (!coverByBookId || coverByBookId.size === 0) {
    return loadPendingTitleAuthorProposals();
  }
  const current = loadPendingTitleAuthorProposals();
  let changed = false;
  const updated = current.map((item) => {
    const nextCover = coverByBookId.get(item.bookId);
    if (nextCover && nextCover !== 'NONE' && nextCover !== item.cover_url) {
      changed = true;
      return { ...item, cover_url: nextCover };
    }
    return item;
  });
  return changed ? savePendingTitleAuthorProposals(updated) : current;
}

export function removePendingTitleAuthorProposalsByIds(bookIds: string[]): TitleAuthorProposal[] {
  if (!bookIds || bookIds.length === 0) return loadPendingTitleAuthorProposals();
  const removeSet = new Set(bookIds);
  const remaining = loadPendingTitleAuthorProposals().filter((p) => !removeSet.has(p.bookId));
  return savePendingTitleAuthorProposals(remaining);
}

export function clearPendingTitleAuthorProposals(): void {
  savePendingTitleAuthorProposals([]);
}
