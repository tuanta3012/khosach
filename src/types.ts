/**
 * Core types for Vietnamese Personal Library Manager (Kho Sách Cá Nhân)
 * Gọn nhẹ, chỉ giữ các trường cốt lõi: Tên sách, Tác giả, Thể loại, Nhà xuất bản.
 */

export interface BookRecord {
  id: string; // Unique Book ID or UUID
  title: string; // Tên sách (Bắt buộc)
  author: string; // Tác giả (Bắt buộc)
  category?: string; // Thể loại (Văn học, Lịch sử, Kinh tế, Y học...)
  publisher?: string; // Nhà xuất bản
  summary?: string; // Tóm tắt nội dung sách ngắn gọn
  created_at?: number; // Epoch Timestamp (ms)
  updated_at?: number; // Epoch Timestamp (ms)
  is_ai_normalized?: boolean; // Đã chuẩn hóa bằng AI chưa
  cover_url?: string; // URL hoặc ảnh thu gọn trang bìa sách ('NONE' nếu không tìm thấy)
}

export interface DraftBookItem {
  tempId: string;
  title: string;
  author: string;
  category?: string;
  publisher?: string;
  isDuplicate?: boolean;
  duplicateMatchTitle?: string;
  confidence?: number;
  enriched?: boolean;
}

export type UserRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

export interface AuthUser {
  email: string;
  name: string;
  photoURL?: string;
  userRole: UserRole;
}

export type NormalizeFieldKey =
  | 'title'
  | 'author'
  | 'publisher'
  | 'category'
  | 'summary'
  | 'cover_url';

export const DEFAULT_NORMALIZE_FIELDS: NormalizeFieldKey[] = [
  'title',
  'author',
  'publisher',
  'category',
  'summary',
  'cover_url',
];

export const NORMALIZE_FIELD_OPTIONS: Array<{ key: NormalizeFieldKey; label: string }> = [
  { key: 'title', label: 'Tên sách' },
  { key: 'author', label: 'Tác giả' },
  { key: 'publisher', label: 'Nhà xuất bản' },
  { key: 'category', label: 'Thể loại' },
  { key: 'summary', label: 'Tóm tắt' },
  { key: 'cover_url', label: 'Ảnh bìa' },
];

export interface Settings {
  autoEnrichEnabled?: boolean;
  driveBackupFolder?: string;
  driveSyncUrl?: string;
  driveTargetFileUrl?: string;
  autoSyncDrive?: boolean;
  lastBackupTime?: string;
  categoriesList?: string[];
  autoNormalizeEnabled?: boolean;
  normalizeFields?: NormalizeFieldKey[];
  geminiApiKeys: string[];
  shareGeminiKeys?: boolean;
  selectedModel?: string;
}

export interface LibrarySettings {
  autoEnrichEnabled: boolean;
  driveBackupFolder?: string;
  driveSyncUrl?: string; // Google Apps Script Web App URL cho đồng bộ 2 chiều
  driveTargetFileUrl?: string; // Link file Google Sheet đồng bộ chung
  autoSyncDrive?: boolean; // Tự động đẩy dữ liệu sạch lên Drive khi có thay đổi
  lastBackupTime?: string;
  categoriesList: string[];
  autoNormalizeEnabled?: boolean;
  normalizeFields?: NormalizeFieldKey[];
  geminiApiKeys?: string[];
  shareGeminiKeys?: boolean;
  selectedModel?: string;
}

export interface DriveBackupPayload {
  version: string;
  exportedAt: string;
  totalBooks: number;
  books: BookRecord[];
}

export type GeminiModelId = 
  | 'auto' 
  | 'gemini-3.5-flash-lite';

export interface GeminiModelInfo {
  id: GeminiModelId;
  name: string;
  desc: string;
}

export interface ScannedBookItem {
  title: string;
  author: string;
  publisher?: string;
  category?: string;
  is_ai_normalized?: boolean;
}

export interface ScanImagesResult {
  success: boolean;
  count: number;
  books: ScannedBookItem[];
  failedImages?: string[];
}

export interface ScanImagesProgressInfo {
  processedImages: number;
  totalImages: number;
  detectedBooksCount: number;
  currentMessage?: string;
}

export type ScanImagesProgressCallback = (progress: ScanImagesProgressInfo) => void;

export interface ScanImagesOptions {
  preferredModel?: string;
  onProgress?: ScanImagesProgressCallback;
  stopSignal?: { current: boolean };
  categories?: string[];
}

export interface BookEnrichmentResult {
  success: boolean;
  sources?: BookSource[];
  sourceWarning?: string;
  error?: string;
  enriched?: {
    title: string;
    author: string;
    publisher?: string;
    publish_year?: number;
    category?: string;
    summary?: string;
    cover_url?: string;
  };
}

export interface BookSource {
  provider: 'Google Books' | 'Open Library' | 'Goodreads' | 'Apple Books' | 'Wikipedia' | 'Web';
  title: string;
  url: string;
  authors: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  coverUrl?: string;
}

export interface NormalizedBookItem {
  id: string;
  title: string;
  author: string;
  publisher: string;
  category: string;
  summary?: string;
  cover_url?: string;
  originalTitle?: string;
  isbn?: string;
  is_ai_normalized: boolean;
  sources?: BookSource[];
  sourceWarning?: string;
}

export interface KeyQuotaState {
  key: string;
  cooldownUntil: number;
  backoffFactor: number;
  isRpdExhausted: boolean;
  rpdExhaustedDate: string;
  apiCallTimestamps: number[];
}

export interface BatchNormalizeFailure {
  chunkIndex: number;
  bookIds: string[];
  message: string;
}

export interface BatchNormalizeResult {
  success: boolean;
  normalized: NormalizedBookItem[];
  failedChunks: BatchNormalizeFailure[];
  stopped: boolean;
}

export interface ReclassifyCategoriesItem {
  id: string;
  category: string;
}

export interface ReclassifyCategoriesOptions {
  preferredModel?: string;
  categories?: string[];
  onChunkComplete?: (
    chunkUpdates: ReclassifyCategoriesItem[],
    processedCount: number,
    totalCount: number
  ) => Promise<void> | void;
  stopSignal?: { current: boolean };
}

export interface ReclassifyCategoriesResult {
  success: boolean;
  updates: ReclassifyCategoriesItem[];
  failedChunks: BatchNormalizeFailure[];
  stopped: boolean;
}

export interface KeyQuotaMetrics {
  keyCount: number;
  healthyKeyCount: number;
  microBatchSize: number;
  concurrency: number;
  maxRpm: number;
  maxRpd: number;
}

export interface GoogleGisTokenResponse {
  access_token?: string;
  expires_in?: string | number;
  error?: string;
  error_description?: string;
}

export type RuleType = 
  | 'VOLUME_DISAMBIGUATION'
  | 'AUTHOR_PREFIX_STRIP'
  | 'AUTHOR_EDITORIAL_STRIP'
  | 'TITLE_NORMALIZATION'
  | 'SUBTITLE_PRESERVE'
  | 'CATEGORY_KEYWORD_MAP'
  | 'TITLE_CLEAN_ENGLISH';

export interface ConsensusRule {
  id: string;
  type: RuleType;
  title: string;
  description: string;
  targetField: 'title' | 'author' | 'category' | 'publisher' | 'pair';
  pattern: string;
  action: 'STRIP' | 'REPLACE' | 'MARK_DISTINCT' | 'SET_CATEGORY' | 'TITLE_CASE' | 'PRESERVE';
  value?: string;
  source: 'COMMUNITY' | 'USER_LOCAL';
  voteCount: number;
  confidenceRate: number;
  updatedAt: number;
}

export type EpubGenreId =
  | 'van-hoc'
  | 'cong-nghe'
  | 'y-khoa'
  | 'kinh-te'
  | 'khoa-hoc'
  | 'lich-su-triet'
  | 'tam-ly-ky-nang'
  | 'giao-trinh'
  | 'tong-hop';

export interface EpubGenreConfig {
  id: EpubGenreId;
  label: string;
  shortDesc: string;
  libraryCategoryHint: string;
  stylePrompt: string;
}

export interface SerializedInlineTag {
  id: number;
  tagName: string;
  attrs: Array<[string, string]>;
  isVoid: boolean;
}

export interface EpubTranslatableSegment {
  segId: number;
  filePath: string;
  kind: 'opf-title' | 'ncx-text' | 'html-block';
  tokenText: string;
  tagRegistry: SerializedInlineTag[];
  charLength: number;
}

export interface EpubTranslationChunk {
  chunkIndex: number;
  filePath: string;
  segmentIds: number[];
  totalChars: number;
}

export interface ParsedEpubData {
  opfPath: string;
  opfDir: string;
  ncxPath?: string;
  navPath?: string;
  spineFilePaths: string[];
  bookTitle: string;
  bookAuthor: string;
  bookPublisher: string;
  bookLanguage: string;
  segments: EpubTranslatableSegment[];
  chunks: EpubTranslationChunk[];
}

export type PdfOutputFormat = 'epub' | 'pdf';
export type PdfProcessingMode = 'auto' | 'hybrid-digital' | 'full-vision';

export type PdfBlockTag =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'p'
  | 'blockquote'
  | 'ul'
  | 'ol'
  | 'pre'
  | 'table'
  | 'figure';

export interface PdfTranslatedBlock {
  tag: PdfBlockTag;
  html: string;
}

export interface PdfExtractedAsset {
  assetId: string;
  pageNumber: number;
  fileName: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PdfPreParsedBlock {
  blockId: number;
  tag: PdfBlockTag;
  text: string;
  isFigure?: boolean;
  assetId?: string;
}

export interface PdfParsedPage {
  pageNumber: number;
  chapterIndex: number;
  chapterTitle: string;
  rawDigitalText: string;
  requiresVision: boolean;
  hasFigures: boolean;
  hasTables: boolean;
  isMultiColumn: boolean;
  hasMathOrGarbled?: boolean;
  figureAreaRatio?: number;
  assetIds: string[];
  blocks: PdfPreParsedBlock[];
}

export interface PdfChapterInfo {
  chapterIndex: number;
  title: string;
  startPage: number;
  endPage: number;
}

export interface ParsedPdfData {
  parserVersion?: number;
  bookTitle: string;
  bookAuthor: string;
  bookPublisher: string;
  totalPages: number;
  chapters: PdfChapterInfo[];
  pages: PdfParsedPage[];
  assets: Record<string, PdfExtractedAsset>;
  visionPageCount: number;
  textOnlyPageCount: number;
}

export interface PdfTranslationUnit {
  unitIndex: number;
  kind: 'vision-page' | 'text-chunk';
  pageNumbers: number[];
  totalChars: number;
}

export interface EpubTranslationJob {
  jobId: string;
  sourceType?: 'epub' | 'pdf';
  fileName: string;
  fileSize: number;
  lastModified: number;
  genre: EpubGenreId;
  customNotes: string;
  epubBuffer: ArrayBuffer;
  parsedData: ParsedEpubData;
  translatedSegments: Record<number, string>;
  // Hỗ trợ dịch PDF Digital (tùy chọn)
  pdfOutputFormat?: PdfOutputFormat;
  pdfProcessingMode?: PdfProcessingMode;
  parsedPdfData?: ParsedPdfData;
  pdfUnits?: PdfTranslationUnit[];
  translatedPdfPages?: Record<number, PdfTranslatedBlock[]>;
  completedChunkIds: number[];
  failedChunkIds: number[];
  status: 'idle' | 'translating' | 'paused' | 'completed' | 'error';
  lastError?: string;
  queueOrder?: number;
  createdAt?: number;
  elapsedMs?: number;
  completedAt?: number;
  lastSavedLocation?: string;
  lastSavedFileName?: string;
  lastSavedFileUri?: string;
  updatedAt: number;
}

export interface EpubTranslationProgress {
  completedChunks: number;
  totalChunks: number;
  completedSegments: number;
  totalSegments: number;
  failedChunks: number;
  activeWorkers: number;
  totalKeys: number;
  statusMessage: string;
}

export interface BookExportProgress {
  stage: string;
  current: number;
  total: number;
  percent: number;
}



