import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BookSource } from '../types';

export interface BookLookupResult {
  sources: BookSource[];
  warning?: string;
}

export interface BookCoverCandidate {
  coverUrl: string;
  title: string;
  author: string;
  provider: BookSource['provider'];
  score: number;
  sourceUrl?: string;
}

interface GoogleBooksResponse {
  items?: Array<{
    volumeInfo?: {
      title?: string;
      authors?: string[];
      publisher?: string;
      publishedDate?: string;
      description?: string;
      infoLink?: string;
      imageLinks?: {
        smallThumbnail?: string;
        thumbnail?: string;
      };
    };
  }>;
}

interface OpenLibraryResponse {
  docs?: Array<{
    key?: string;
    title?: string;
    author_name?: string[];
    publisher?: string[];
    first_publish_year?: number;
    cover_i?: number;
    isbn?: string[];
  }>;
}

interface GoodreadsAutoCompleteItem {
  bookId?: string;
  title?: string;
  bookTitleBare?: string;
  imageUrl?: string;
  bookUrl?: string;
  author?: {
    name?: string;
  };
  authorName?: string;
}

interface AppleBooksResponse {
  results?: Array<{
    trackName?: string;
    artistName?: string;
    artworkUrl100?: string;
    trackViewUrl?: string;
  }>;
}

interface WikipediaQueryResponse {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        thumbnail?: {
          source?: string;
          width?: number;
          height?: number;
        };
      }
    >;
  };
}

const API_BASE = ((import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || '').replace(/\/$/, '');
const CACHE_KEY = 'book_lookup_cache_v2';
const COVER_CACHE_KEY = 'book_cover_lookup_cache_v1';
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 160;

const lookupCache = new Map<string, { savedAt: number; result: BookLookupResult }>();
const coverCache = new Map<string, { savedAt: number; candidates: BookCoverCandidate[] }>();
let cacheLoaded = false;
let coverCacheLoaded = false;

const providerRequestQueues = new Map<string, Promise<void>>();
const providerNextRequestAt = new Map<string, number>();

const PROVIDER_MIN_INTERVAL_MS: Record<string, number> = {
  'Open Library': 550,
  Goodreads: 220,
  'Apple Books': 220,
  'Google Books': 250,
  Wikipedia: 150,
  Web: 180,
};

function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function fetchWithRateLimit(
  url: string,
  provider: BookSource['provider'],
  options?: { useNativeHttp?: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  const providerKey = provider || 'Web';
  let release!: () => void;
  const previous = providerRequestQueues.get(providerKey) || Promise.resolve();
  const nextQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  providerRequestQueues.set(providerKey, nextQueue);
  await previous;

  try {
    const nextRequestAt = providerNextRequestAt.get(providerKey) || 0;
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    const minInterval = PROVIDER_MIN_INTERVAL_MS[providerKey] ?? 250;
    providerNextRequestAt.set(providerKey, Date.now() + minInterval);

    const timeoutMs = options?.timeoutMs || 4800;

    if (options?.useNativeHttp && isNativePlatform()) {
      const res = await CapacitorHttp.get({
        url,
        headers: {
          Accept: 'application/json, text/html, */*',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
        },
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      const ok = res.status >= 200 && res.status < 300;
      return {
        ok,
        status: res.status,
        json: async () => (typeof res.data === 'string' ? JSON.parse(res.data) : res.data),
        text: async () => (typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')),
      };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const resp = await fetch(url, {
        ...(controller ? { signal: controller.signal } : {}),
      });
      return resp;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    release();
  }
}

export function normalizedBookText(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleMatches(query: string, candidate: string): boolean {
  const normalizedQuery = normalizedBookText(query);
  const normalizedCandidate = normalizedBookText(candidate);
  if (!normalizedQuery || !normalizedCandidate) return false;
  if (normalizedQuery === normalizedCandidate) return true;

  const queryTokens = new Set(normalizedQuery.split(' ').filter(Boolean));
  const candidateTokens = new Set(normalizedCandidate.split(' ').filter(Boolean));
  if (queryTokens.size === 0 || candidateTokens.size === 0) return false;

  const intersection = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
  const overlap = intersection / Math.min(queryTokens.size, candidateTokens.size);
  if (queryTokens.size >= 2 && candidateTokens.size >= 2) {
    return overlap >= 0.72 && (normalizedQuery.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedQuery) || intersection >= 2);
  }
  return overlap >= 0.9 && normalizedQuery === normalizedCandidate;
}

function stripTitleSubtitles(title: string): string {
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*[-–—:]\s*tập\s*\d+.*$/i, '')
    .replace(/\s+tập\s*\d+$/i, '')
    .replace(/\s*[:：]\s*.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnknownAuthor(author: string): boolean {
  const norm = normalizedBookText(author);
  return (
    !norm ||
    norm === 'chua ro' ||
    norm === 'khuyet danh' ||
    norm === 'nhieu tac gia' ||
    norm === 'unknown' ||
    norm === 'anonymous'
  );
}

function cleanAuthorForQuery(author: string): string {
  if (isUnknownAuthor(author)) return '';
  return String(author || '')
    .split(/[,;&/]/)[0]
    .replace(/\([^)]*\)/g, '')
    .trim();
}

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') as Array<[string, { savedAt: number; result: BookLookupResult }]>;
    const now = Date.now();
    for (const [key, value] of saved) {
      if (value && now - value.savedAt < CACHE_TTL_MS) lookupCache.set(key, value);
    }
  } catch (error) {
    console.warn('[Book Lookup] Could not read cached search results:', error);
  }
}

function saveCache(): void {
  const entries = [...lookupCache.entries()].slice(-MAX_CACHE_ENTRIES);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch {}
}

function loadCoverCache(): void {
  if (coverCacheLoaded) return;
  coverCacheLoaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(COVER_CACHE_KEY) || '[]') as Array<[string, { savedAt: number; candidates: BookCoverCandidate[] }]>;
    const now = Date.now();
    for (const [key, value] of saved) {
      if (value && now - value.savedAt < CACHE_TTL_MS) coverCache.set(key, value);
    }
  } catch {}
}

function saveCoverCache(): void {
  const entries = [...coverCache.entries()].slice(-MAX_CACHE_ENTRIES);
  try {
    localStorage.setItem(COVER_CACHE_KEY, JSON.stringify(entries));
  } catch {}
}

function getSafeHttpsUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value.replace(/^http:\/\//i, 'https://'));
    return url.protocol === 'https:' ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeGoodreadsCoverUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const clean = rawUrl.trim().replace(/^http:\/\//i, 'https://');
  if (!clean || clean.includes('nophoto/book') || clean.includes('nophoto/user')) return '';
  // Upgrade thumbnail (._SY75_., ._SX50_.) to full-resolution Goodreads cover URL
  return clean.replace(/\._S[XY]\d+_(?=\.(?:jpg|jpeg|png|webp))/i, '');
}

function normalizeGoogleBooksCoverUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  return rawUrl
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .replace(/&edge=curl/gi, '')
    .replace(/&zoom=\d/gi, '&zoom=1');
}

function scoreCoverMatch(
  queryTitle: string,
  queryAuthor: string,
  candTitle: string,
  candAuthor: string,
  provider: BookSource['provider'],
  extraOriginalTitle = ''
): number {
  const qTitle = normalizedBookText(queryTitle);
  const qShort = normalizedBookText(stripTitleSubtitles(queryTitle));
  const qOrig = normalizedBookText(extraOriginalTitle);
  const cTitle = normalizedBookText(candTitle);
  const cShort = normalizedBookText(stripTitleSubtitles(candTitle));

  if (!cTitle) return 0;

  let titleScore = 0;
  const targets = [qTitle, qShort, qOrig].filter(Boolean);
  for (const target of targets) {
    if (cTitle === target || cShort === target) {
      titleScore = Math.max(titleScore, 100);
    } else if (cTitle.includes(target) || target.includes(cTitle)) {
      titleScore = Math.max(titleScore, 82);
    } else {
      const tWords = new Set(target.split(' ').filter(Boolean));
      const cWords = new Set(cTitle.split(' ').filter(Boolean));
      const shared = [...tWords].filter((w) => cWords.has(w)).length;
      const ratio = shared / Math.max(1, Math.min(tWords.size, cWords.size));
      if (ratio >= 0.75 && shared >= 2) {
        titleScore = Math.max(titleScore, Math.round(ratio * 78));
      } else if (ratio >= 0.6 && shared >= 3) {
        titleScore = Math.max(titleScore, Math.round(ratio * 65));
      }
    }
  }

  if (titleScore < 48) return 0;

  let authorScore = 0;
  const qAuthor = normalizedBookText(cleanAuthorForQuery(queryAuthor));
  const cAuthor = normalizedBookText(candAuthor);
  if (qAuthor && cAuthor) {
    if (cAuthor === qAuthor || cAuthor.includes(qAuthor) || qAuthor.includes(cAuthor)) {
      authorScore = 30;
    } else {
      const qaWords = qAuthor.split(' ').filter(Boolean);
      const caWords = cAuthor.split(' ').filter(Boolean);
      const lastQa = qaWords[qaWords.length - 1];
      const hasLast = lastQa && caWords.includes(lastQa);
      const sharedA = qaWords.filter((w) => caWords.includes(w)).length;
      if (sharedA >= 2 || (hasLast && qaWords.length <= 2)) {
        authorScore = 20;
      } else {
        // Explicit author mismatch penalty
        authorScore = -35;
      }
    }
  }

  const providerBonus =
    provider === 'Goodreads'
      ? 14
      : provider === 'Apple Books'
      ? 10
      : provider === 'Google Books'
      ? 8
      : provider === 'Open Library'
      ? 6
      : 4;

  return Math.max(0, titleScore + authorScore + providerBonus);
}

async function searchGoogleBooks(title: string, author: string): Promise<BookSource[]> {
  const query = [`intitle:${title}`, author ? `inauthor:${author}` : ''].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: query, maxResults: '5', printType: 'books' });
  const response = await fetchWithRateLimit(
    `https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
    'Google Books'
  );
  if (!response.ok) throw new Error(`Google Books returned HTTP ${response.status}.`);

  const payload = (await response.json()) as GoogleBooksResponse;
  return (payload.items || []).flatMap((item) => {
    const volume = item.volumeInfo;
    if (!volume?.title || !titleMatches(title, volume.title)) return [];
    const coverUrl = normalizeGoogleBooksCoverUrl(
      volume.imageLinks?.thumbnail || volume.imageLinks?.smallThumbnail
    );
    return [
      {
        provider: 'Google Books' as const,
        title: volume.title,
        url: getSafeHttpsUrl(volume.infoLink, 'https://books.google.com/'),
        authors: volume.authors || [],
        publisher: volume.publisher,
        publishedDate: volume.publishedDate,
        description: volume.description?.slice(0, 1200),
        ...(coverUrl ? { coverUrl } : {}),
      },
    ];
  });
}

async function searchOpenLibrary(title: string, author: string): Promise<BookSource[]> {
  const params = new URLSearchParams({
    title,
    limit: '5',
    fields: 'key,title,author_name,publisher,first_publish_year,cover_i,isbn',
  });
  if (author) params.set('author', author);
  const response = await fetchWithRateLimit(
    `https://openlibrary.org/search.json?${params.toString()}`,
    'Open Library'
  );
  if (!response.ok) throw new Error(`Open Library returned HTTP ${response.status}.`);

  const payload = (await response.json()) as OpenLibraryResponse;
  return (payload.docs || []).flatMap((doc) => {
    if (!doc.title || !titleMatches(title, doc.title)) return [];
    const path = doc.key?.startsWith('/works/') ? doc.key : '';
    const coverUrl = doc.cover_i
      ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
      : doc.isbn?.[0]
      ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(doc.isbn[0])}-M.jpg?default=false`
      : '';
    return [
      {
        provider: 'Open Library' as const,
        title: doc.title,
        url: path ? `https://openlibrary.org${path}` : 'https://openlibrary.org/',
        authors: doc.author_name || [],
        publisher: doc.publisher?.slice(0, 3).join(', '),
        publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
        ...(coverUrl ? { coverUrl } : {}),
      },
    ];
  });
}

export async function findBookSources(title: string, author = ''): Promise<BookLookupResult> {
  loadCache();
  const cleanTitle = title.trim();
  const cleanAuthor = author.trim();
  if (!cleanTitle) return { sources: [] };

  const cacheKey = normalizedBookText(`${cleanTitle} ${cleanAuthor}`);
  const cached = lookupCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.result;

  const warnings: string[] = [];
  let sources: BookSource[] = [];
  try {
    sources = await searchGoogleBooks(cleanTitle, cleanAuthor);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    console.warn('[Book Lookup] Google Books search failed:', error);
  }

  if (sources.length === 0) {
    try {
      sources = await searchOpenLibrary(cleanTitle, cleanAuthor);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      console.warn('[Book Lookup] Open Library search failed:', error);
    }
  }

  const result: BookLookupResult = {
    sources,
    ...(sources.length === 0 && warnings.length > 0
      ? { warning: `Không thể tra cứu nguồn sách lúc này: ${warnings.join(' ')}` }
      : {}),
  };
  if (!result.warning) lookupCache.set(cacheKey, { savedAt: Date.now(), result });
  while (lookupCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = lookupCache.keys().next().value;
    if (oldestKey === undefined) break;
    lookupCache.delete(oldestKey);
  }
  saveCache();
  return result;
}

async function searchGoodreadsCoverCandidates(
  query: string,
  refTitle: string,
  refAuthor: string,
  extraOriginalTitle = ''
): Promise<BookCoverCandidate[]> {
  const cleanQ = query.trim();
  if (!cleanQ) return [];

  try {
    const useNative = isNativePlatform();
    const targetUrl = useNative
      ? `https://www.goodreads.com/book/auto_complete?format=json&q=${encodeURIComponent(cleanQ)}`
      : `${API_BASE}/api/covers/goodreads?q=${encodeURIComponent(cleanQ)}`;

    const resp = await fetchWithRateLimit(targetUrl, 'Goodreads', {
      useNativeHttp: useNative,
      timeoutMs: 6000,
    });
    if (!resp.ok) return [];

    const items = (await resp.json()) as GoodreadsAutoCompleteItem[];
    if (!Array.isArray(items)) return [];

    const candidates: BookCoverCandidate[] = [];
    for (const item of items.slice(0, 6)) {
      const coverUrl = normalizeGoodreadsCoverUrl(item.imageUrl);
      if (!coverUrl) continue;
      const candTitle = String(item.bookTitleBare || item.title || '').trim();
      const candAuthor = String(item.author?.name || item.authorName || '').trim();
      const score = scoreCoverMatch(refTitle, refAuthor, candTitle, candAuthor, 'Goodreads', extraOriginalTitle);
      if (score < 52) continue;

      candidates.push({
        coverUrl,
        title: candTitle || refTitle,
        author: candAuthor || refAuthor,
        provider: 'Goodreads',
        score,
        sourceUrl: item.bookUrl ? `https://www.goodreads.com${item.bookUrl}` : undefined,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function searchAppleBooksCoverCandidates(
  query: string,
  refTitle: string,
  refAuthor: string,
  country?: string,
  extraOriginalTitle = ''
): Promise<BookCoverCandidate[]> {
  const cleanQ = query.trim();
  if (!cleanQ) return [];
  try {
    const params = new URLSearchParams({
      term: cleanQ,
      entity: 'ebook',
      limit: '5',
      ...(country ? { country } : {}),
    });
    const resp = await fetchWithRateLimit(
      `https://itunes.apple.com/search?${params.toString()}`,
      'Apple Books',
      { timeoutMs: 5500 }
    );
    if (!resp.ok) return [];
    const payload = (await resp.json()) as AppleBooksResponse;
    const candidates: BookCoverCandidate[] = [];
    for (const item of payload.results || []) {
      const rawArt = item.artworkUrl100 || '';
      if (!rawArt) continue;
      const coverUrl = rawArt.replace(/^http:\/\//i, 'https://').replace(/100x100bb/i, '400x400bb');
      const candTitle = String(item.trackName || '').trim();
      const candAuthor = String(item.artistName || '').trim();
      const score = scoreCoverMatch(refTitle, refAuthor, candTitle, candAuthor, 'Apple Books', extraOriginalTitle);
      if (score < 56) continue;
      candidates.push({
        coverUrl,
        title: candTitle || refTitle,
        author: candAuthor || refAuthor,
        provider: 'Apple Books',
        score,
        sourceUrl: item.trackViewUrl,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function searchOpenLibraryCoverCandidates(
  title: string,
  author: string,
  isbn?: string,
  extraOriginalTitle = ''
): Promise<BookCoverCandidate[]> {
  const cleanTitle = title.trim();
  const cleanIsbn = (isbn || '').replace(/[^0-9Xx]/g, '');
  if (!cleanTitle && !cleanIsbn) return [];

  try {
    const params = new URLSearchParams({
      limit: '5',
      fields: 'key,title,author_name,cover_i,isbn',
    });
    if (cleanIsbn) {
      params.set('isbn', cleanIsbn);
    } else {
      params.set('title', cleanTitle);
      if (author) params.set('author', author);
    }

    const resp = await fetchWithRateLimit(
      `https://openlibrary.org/search.json?${params.toString()}`,
      'Open Library',
      { timeoutMs: 6000 }
    );
    if (!resp.ok) return [];
    const payload = (await resp.json()) as OpenLibraryResponse;

    const candidates: BookCoverCandidate[] = [];
    for (const doc of payload.docs || []) {
      const candTitle = String(doc.title || '').trim();
      const candAuthor = (doc.author_name || []).join(', ');
      const coverUrl = doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
        : doc.isbn?.[0]
        ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(doc.isbn[0])}-M.jpg?default=false`
        : '';
      if (!coverUrl) continue;

      const score = cleanIsbn
        ? 95
        : scoreCoverMatch(cleanTitle, author, candTitle, candAuthor, 'Open Library', extraOriginalTitle);
      if (score < 56) continue;

      candidates.push({
        coverUrl,
        title: candTitle || cleanTitle,
        author: candAuthor || author,
        provider: 'Open Library',
        score,
        sourceUrl: doc.key ? `https://openlibrary.org${doc.key}` : undefined,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function searchGoogleBooksCoverCandidates(
  title: string,
  author: string,
  isbn?: string,
  extraOriginalTitle = ''
): Promise<BookCoverCandidate[]> {
  const cleanTitle = title.trim();
  const cleanIsbn = (isbn || '').replace(/[^0-9Xx]/g, '');
  if (!cleanTitle && !cleanIsbn) return [];

  try {
    const query = cleanIsbn
      ? `isbn:${cleanIsbn}`
      : [cleanTitle ? `intitle:${cleanTitle}` : '', author ? `inauthor:${author}` : '']
          .filter(Boolean)
          .join(' ');
    const params = new URLSearchParams({ q: query, maxResults: '5', printType: 'books' });
    const resp = await fetchWithRateLimit(
      `https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
      'Google Books',
      { timeoutMs: 5500 }
    );
    if (!resp.ok) return [];
    const payload = (await resp.json()) as GoogleBooksResponse;

    const candidates: BookCoverCandidate[] = [];
    for (const item of payload.items || []) {
      const v = item.volumeInfo;
      const coverUrl = normalizeGoogleBooksCoverUrl(v?.imageLinks?.thumbnail || v?.imageLinks?.smallThumbnail);
      if (!v?.title || !coverUrl) continue;
      const candAuthor = (v.authors || []).join(', ');
      const score = cleanIsbn
        ? 96
        : scoreCoverMatch(cleanTitle, author, v.title, candAuthor, 'Google Books', extraOriginalTitle);
      if (score < 56) continue;

      candidates.push({
        coverUrl,
        title: v.title,
        author: candAuthor || author,
        provider: 'Google Books',
        score,
        sourceUrl: getSafeHttpsUrl(v.infoLink, 'https://books.google.com/'),
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function searchWikipediaCoverCandidate(title: string, author: string): Promise<BookCoverCandidate[]> {
  const cleanTitle = stripTitleSubtitles(title);
  if (!cleanTitle) return [];
  try {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: cleanTitle,
      gsrlimit: '4',
      prop: 'pageimages',
      pithumbsize: '400',
      format: 'json',
      origin: '*',
    });
    const resp = await fetchWithRateLimit(
      `https://vi.wikipedia.org/w/api.php?${params.toString()}`,
      'Wikipedia',
      { timeoutMs: 5000 }
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as WikipediaQueryResponse;
    const pages = Object.values(data?.query?.pages || {});
    const candidates: BookCoverCandidate[] = [];

    for (const page of pages) {
      const pageTitle = (page.title || '').trim();
      const thumb = page.thumbnail?.source;
      if (!pageTitle || !thumb) continue;
      // Chỉ chấp nhận nếu tiêu đề trang Wikipedia thực sự là tên cuốn sách (tránh ảnh chân dung tác giả!)
      const cleanPageTitle = pageTitle.replace(/\s*\((?:tiểu thuyết|truyện|sách|tác phẩm)\)\s*$/i, '').trim();
      if (!titleMatches(cleanTitle, cleanPageTitle)) continue;

      const score = scoreCoverMatch(title, author, cleanPageTitle, '', 'Wikipedia');
      if (score < 70) continue;

      candidates.push({
        coverUrl: thumb.replace(/^http:\/\//i, 'https://'),
        title: pageTitle,
        author,
        provider: 'Wikipedia',
        score,
        sourceUrl: `https://vi.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/\s+/g, '_'))}`,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

function deduplicateAndSortCandidates(list: BookCoverCandidate[]): BookCoverCandidate[] {
  const map = new Map<string, BookCoverCandidate>();
  for (const cand of list) {
    if (!cand.coverUrl) continue;
    const existing = map.get(cand.coverUrl);
    if (!existing || cand.score > existing.score) {
      map.set(cand.coverUrl, cand);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.score - a.score);
}

/**
 * Tìm danh sách ảnh bìa sách ứng viên từ các nguồn thư mục mở (Goodreads, Apple Books, Open Library, Google Books, Wikipedia).
 * Hỗ trợ truyền thêm gợi ý tên gốc / ISBN / searchQuery từ AI.
 */
export async function findBookCoverCandidates(
  title: string,
  author = '',
  options?: {
    originalTitle?: string;
    originalAuthor?: string;
    altSearchQuery?: string;
    isbn?: string;
    skipCache?: boolean;
  }
): Promise<BookCoverCandidate[]> {
  loadCoverCache();
  const cleanTitle = (title || '').trim();
  const cleanAuthor = cleanAuthorForQuery(author);
  const shortTitle = stripTitleSubtitles(cleanTitle);
  const origTitle = (options?.originalTitle || '').trim();
  const origAuthor = cleanAuthorForQuery(options?.originalAuthor || '') || cleanAuthor;
  const isbn = (options?.isbn || '').replace(/[^0-9Xx]/g, '');

  if (!cleanTitle && !isbn) return [];

  const cacheKey = normalizedBookText(`${cleanTitle} ${cleanAuthor} ${origTitle} ${isbn}`);
  if (!options?.skipCache) {
    const cached = coverCache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS && cached.candidates.length > 0) {
      return cached.candidates;
    }
  }

  const queries: string[] = [];
  if (cleanTitle) {
    queries.push([cleanTitle, cleanAuthor].filter(Boolean).join(' '));
  }
  if (shortTitle && shortTitle !== cleanTitle) {
    queries.push([shortTitle, cleanAuthor].filter(Boolean).join(' '));
  }
  if (options?.altSearchQuery && !queries.includes(options.altSearchQuery)) {
    queries.push(options.altSearchQuery);
  }
  if (origTitle && origTitle !== cleanTitle) {
    queries.push([origTitle, origAuthor].filter(Boolean).join(' '));
  }
  const uniqueQueries = Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean)));

  const allCandidates: BookCoverCandidate[] = [];
  const intlTitle = origTitle || shortTitle || cleanTitle;
  const intlAuthor = origAuthor || cleanAuthor;
  const primaryGoodreadsQuery = uniqueQueries[0] || '';
  const secondaryGoodreadsQuery = uniqueQueries[1] || '';

  // Chạy song song Goodreads (truy vấn chính) + Open Library + Apple Books + Google Books + Wikipedia
  const primaryTasks: Array<Promise<BookCoverCandidate[]>> = [
    ...(primaryGoodreadsQuery
      ? [searchGoodreadsCoverCandidates(primaryGoodreadsQuery, cleanTitle, author, origTitle)]
      : []),
    searchOpenLibraryCoverCandidates(intlTitle, intlAuthor, isbn || undefined, origTitle),
    searchAppleBooksCoverCandidates(
      [intlTitle, intlAuthor].filter(Boolean).join(' '),
      cleanTitle,
      author,
      origTitle ? undefined : 'vn',
      origTitle
    ),
    searchGoogleBooksCoverCandidates(shortTitle || cleanTitle, cleanAuthor, isbn || undefined, origTitle),
    searchWikipediaCoverCandidate(cleanTitle, author),
  ];

  const primarySettled = await Promise.all(primaryTasks);
  for (const group of primarySettled) {
    allCandidates.push(...group);
  }

  // Chỉ gọi thêm Goodreads phụ/ASCII nếu vòng song song chưa có kết quả độ khớp cao (>= 82)
  if (!allCandidates.some((c) => c.score >= 82)) {
    const asciiFallbackQuery = normalizedBookText([shortTitle || cleanTitle, cleanAuthor].filter(Boolean).join(' '));
    const extraTasks: Array<Promise<BookCoverCandidate[]>> = [];
    if (secondaryGoodreadsQuery) {
      extraTasks.push(searchGoodreadsCoverCandidates(secondaryGoodreadsQuery, cleanTitle, author, origTitle));
    }
    if (
      allCandidates.length === 0 &&
      asciiFallbackQuery &&
      !uniqueQueries.some((q) => normalizedBookText(q) === asciiFallbackQuery)
    ) {
      extraTasks.push(searchGoodreadsCoverCandidates(asciiFallbackQuery, cleanTitle, author, origTitle));
    }
    if (extraTasks.length > 0) {
      const extraSettled = await Promise.all(extraTasks);
      for (const group of extraSettled) {
        allCandidates.push(...group);
      }
    }
  }

  const finalCandidates = deduplicateAndSortCandidates(allCandidates).slice(0, 8);
  if (finalCandidates.length > 0) {
    coverCache.set(cacheKey, { savedAt: Date.now(), candidates: finalCandidates });
    while (coverCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = coverCache.keys().next().value;
      if (oldestKey === undefined) break;
      coverCache.delete(oldestKey);
    }
    saveCoverCache();
  }

  return finalCandidates;
}

/**
 * Kiểm tra ảnh bìa có thực sự tải được trên trình duyệt / WebView hay không (tránh ảnh 404 hoặc pixel rỗng).
 */
export function verifyCoverImageLoadable(url: string, timeoutMs = 2800): Promise<boolean> {
  if (!url || typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(Boolean(url));
  }
  const cleanUrl = url.trim();
  if (cleanUrl.startsWith('data:image/')) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => {
      finish(img.naturalWidth >= 40 && img.naturalHeight >= 50);
    };
    img.onerror = () => finish(false);
    img.src = cleanUrl;
  });
}

/**
 * Trích xuất og:image từ URL trang sách (dùng cho kết quả Google Search Grounding).
 */
export async function fetchOgImageFromBookPage(pageUrl: string): Promise<string> {
  const clean = (pageUrl || '').trim();
  if (!clean.startsWith('https://')) return '';

  try {
    if (isNativePlatform()) {
      const resp = await CapacitorHttp.get({
        url: clean,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        connectTimeout: 5500,
        readTimeout: 5500,
      });
      if (resp.status < 200 || resp.status >= 300) return '';
      const html = String(resp.data || '').slice(0, 120_000);
      const ogMatch =
        html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
        html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      const imgUrl = ogMatch?.[1]?.trim() || '';
      return imgUrl && /^https?:\/\//i.test(imgUrl) ? imgUrl.replace(/^http:\/\//i, 'https://') : '';
    }

    const resp = await fetch(`${API_BASE}/api/covers/og?url=${encodeURIComponent(clean)}`);
    if (!resp.ok) return '';
    const data = await resp.json();
    return typeof data?.imageUrl === 'string' ? data.imageUrl.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Nén ảnh người dùng tải lên từ thiết bị thành thumbnail nhỏ gọn (JPEG <= ~15KB) để lưu an toàn.
 */
export function compressImageFileToCoverDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh đã chọn.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Tệp ảnh không hợp lệ.'));
      img.onload = () => {
        const maxW = 210;
        const maxH = 300;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Không thể khởi tạo trình xử lý ảnh.'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}
