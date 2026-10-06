import { BookSource } from '../types';

export interface BookLookupResult {
  sources: BookSource[];
  warning?: string;
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
  }>;
}

const CACHE_KEY = 'book_lookup_cache_v1';
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;
const lookupCache = new Map<string, { savedAt: number; result: BookLookupResult }>();
let cacheLoaded = false;
let requestQueue: Promise<void> = Promise.resolve();
let nextGoogleBooksRequestAt = 0;
let nextOpenLibraryRequestAt = 0;

async function fetchLookup(url: string, provider: BookSource['provider']): Promise<Response> {
  let release!: () => void;
  const previous = requestQueue;
  requestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const nextRequestAt = provider === 'Open Library'
      ? nextOpenLibraryRequestAt
      : nextGoogleBooksRequestAt;
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (provider === 'Open Library') nextOpenLibraryRequestAt = Date.now() + 1100;
    else nextGoogleBooksRequestAt = Date.now() + 350;
    return await fetch(url);
  } finally {
    release();
  }
}

function normalizedText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleMatches(query: string, candidate: string): boolean {
  const normalizedQuery = normalizedText(query);
  const normalizedCandidate = normalizedText(candidate);
  if (!normalizedQuery || !normalizedCandidate) return false;
  if (normalizedQuery === normalizedCandidate) return true;

  const queryTokens = new Set(normalizedQuery.split(' ').filter(Boolean));
  const candidateTokens = new Set(normalizedCandidate.split(' ').filter(Boolean));
  if (queryTokens.size < 2 || candidateTokens.size < 2) return false;

  const intersection = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
  const overlap = intersection / Math.min(queryTokens.size, candidateTokens.size);
  return overlap >= 0.85 &&
    (normalizedQuery.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedQuery));
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
  } catch (error) {
    console.warn('[Book Lookup] Could not persist cached search results:', error);
  }
}

function getSafeHttpsUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

async function searchGoogleBooks(title: string, author: string): Promise<BookSource[]> {
  const query = [`intitle:${title}`, author ? `inauthor:${author}` : ''].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: query, maxResults: '5', printType: 'books' });
  const response = await fetchLookup(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, 'Google Books');
  if (!response.ok) throw new Error(`Google Books returned HTTP ${response.status}.`);

  const payload = await response.json() as GoogleBooksResponse;
  return (payload.items || []).flatMap((item) => {
    const volume = item.volumeInfo;
    if (!volume?.title || !titleMatches(title, volume.title)) return [];
    return [{
      provider: 'Google Books' as const,
      title: volume.title,
      url: getSafeHttpsUrl(volume.infoLink, 'https://books.google.com/'),
      authors: volume.authors || [],
      publisher: volume.publisher,
      publishedDate: volume.publishedDate,
      description: volume.description?.slice(0, 1200),
    }];
  });
}

async function searchOpenLibrary(title: string, author: string): Promise<BookSource[]> {
  const params = new URLSearchParams({
    title,
    limit: '5',
    fields: 'key,title,author_name,publisher,first_publish_year',
  });
  if (author) params.set('author', author);
  const response = await fetchLookup(`https://openlibrary.org/search.json?${params.toString()}`, 'Open Library');
  if (!response.ok) throw new Error(`Open Library returned HTTP ${response.status}.`);

  const payload = await response.json() as OpenLibraryResponse;
  return (payload.docs || []).flatMap((doc) => {
    if (!doc.title || !titleMatches(title, doc.title)) return [];
    const path = doc.key?.startsWith('/works/') ? doc.key : '';
    return [{
      provider: 'Open Library' as const,
      title: doc.title,
      url: path ? `https://openlibrary.org${path}` : 'https://openlibrary.org/',
      authors: doc.author_name || [],
      publisher: doc.publisher?.slice(0, 3).join(', '),
      publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
    }];
  });
}

export async function findBookSources(title: string, author = ''): Promise<BookLookupResult> {
  loadCache();
  const cleanTitle = title.trim();
  const cleanAuthor = author.trim();
  if (!cleanTitle) return { sources: [] };

  const cacheKey = normalizedText(`${cleanTitle} ${cleanAuthor}`);
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
