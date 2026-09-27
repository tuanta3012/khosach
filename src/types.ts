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
  created_at?: number; // Epoch Timestamp (ms)
  updated_at?: number; // Epoch Timestamp (ms)
  is_ai_normalized?: boolean; // Đã chuẩn hóa bằng AI chưa
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
  isOffline?: boolean;
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
}

export interface DriveBackupPayload {
  version: string;
  exportedAt: string;
  totalBooks: number;
  books: BookRecord[];
}
