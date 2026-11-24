import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { getSharedFirestore, isDeviceOffline } from './firebaseDb';
import { log } from '../utils/logger';

export interface AssignedShareRecord {
  assignedFileId: string;
  assignedFileName?: string;
  adminEmail: string;
  memberEmail: string;
  role: 'Owner' | 'Editor' | 'Viewer';
  status?: 'active' | 'unlinked';
  createdAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
}

// Bộ nhớ đệm phiên giúp tránh ghi lặp lại lên Firestore khi bản ghi của thành viên đã khớp
const publishedRelaySignatureCache = new Map<string, string>();

function buildRelaySignature(
  fileId: string,
  fileName: string,
  role: 'Owner' | 'Editor' | 'Viewer',
  adminEmail: string
): string {
  return `${fileId}::${(fileName || 'Kho Sách').trim()}::${role}::${(adminEmail || '').trim().toLowerCase()}::active`;
}

/**
 * Chuẩn hóa email thành document ID an toàn cho Firestore
 * Ví dụ: tuanta3012@gmail.com -> tuanta3012_at_gmail_dot_com
 */
export function sanitizeEmailKey(email: string): string {
  if (!email) return '';
  return email
    .trim()
    .toLowerCase()
    .replace(/@/g, '_at_')
    .replace(/\./g, '_dot_')
    .replace(/[^a-z0-9_]/g, '_');
}

/**
 * Admin phát hành liên kết file lên Firestore khi thêm thành viên mới hoặc khi Admin khởi tạo / liên kết file
 */
export async function publishAssignedFile(
  memberEmail: string,
  fileId: string,
  fileName: string,
  adminEmail: string,
  role: 'Owner' | 'Editor' | 'Viewer',
  options?: { onlyIfMissingOrChanged?: boolean }
): Promise<boolean> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey || !fileId) return false;

    const cleanTitle = (fileName || 'Kho Sách').trim() || 'Kho Sách';
    const cleanAdmin = (adminEmail || '').trim().toLowerCase();
    const signature = buildRelaySignature(fileId, cleanTitle, role, cleanAdmin);

    if (options?.onlyIfMissingOrChanged && publishedRelaySignatureCache.get(emailKey) === signature) {
      return true;
    }
    if (isDeviceOffline()) {
      return false;
    }

    const docRef = doc(getSharedFirestore(), 'assigned_shares', emailKey);
    let existingCreatedAt: number | undefined;

    if (options?.onlyIfMissingOrChanged) {
      const existingSnap = await getDoc(docRef);
      if (existingSnap.exists()) {
        const existingData = existingSnap.data() as Partial<AssignedShareRecord>;
        existingCreatedAt = existingData.createdAt;
        const alreadyMatches =
          existingData.assignedFileId === fileId &&
          (existingData.assignedFileName || 'Kho Sách').trim() === cleanTitle &&
          existingData.role === role &&
          existingData.status === 'active' &&
          (!cleanAdmin || (existingData.adminEmail || '').trim().toLowerCase() === cleanAdmin);

        if (alreadyMatches) {
          publishedRelaySignatureCache.set(emailKey, signature);
          return true;
        }
      }
    }

    const now = Date.now();
    const data: AssignedShareRecord = {
      assignedFileId: fileId,
      assignedFileName: cleanTitle,
      adminEmail: cleanAdmin,
      memberEmail: memberEmail.trim().toLowerCase(),
      role,
      status: 'active',
      createdAt: existingCreatedAt || now,
      updatedAt: now,
    };

    await setDoc(docRef, data, { merge: true });
    publishedRelaySignatureCache.set(emailKey, signature);
    log.info(`[ShareRelay] Đã phát hành liên kết file ${fileId} cho ${memberEmail} (${role}) lên Firestore`);
    return true;
  } catch (err: any) {
    const isOffline =
      err?.code === 'unavailable' ||
      err?.code === 'failed-precondition' ||
      /offline|unavailable|network|failed|internet/i.test(err?.message || '') ||
      (typeof navigator !== 'undefined' && !navigator.onLine);

    if (isOffline) {
      log.info('[ShareRelay] Thiết bị ngoại tuyến, bỏ qua lưu liên kết lên Firestore.');
    } else {
      log.warn('[ShareRelay] Ghi liên kết file lên Firestore thất bại:', err?.message || err);
    }
    return false;
  }
}

/**
 * Admin phát hành liên kết file cho toàn bộ danh sách thành viên hiện tại
 */
export async function publishAssignedFilesForMembers(
  members: Array<{ email: string; role: string }>,
  fileId: string,
  fileName: string,
  adminEmail: string,
  options?: { onlyIfMissingOrChanged?: boolean }
): Promise<number> {
  if (!fileId) return 0;
  const cleanAdmin = (adminEmail || '').trim().toLowerCase();
  let count = 0;

  // Phát hành liên kết cho từng thành viên trong danh sách (Chỉ dành cho thành viên được chia sẻ, không tạo relay cho Owner/Admin)
  for (const m of (members || [])) {
    const cleanMemberEmail = (m.email || '').trim().toLowerCase();
    if (!cleanMemberEmail || cleanMemberEmail === cleanAdmin || m.role === 'Owner') {
      continue;
    }
    const role: 'Editor' | 'Viewer' = m.role === 'Editor' ? 'Editor' : 'Viewer';
    const success = await publishAssignedFile(
      cleanMemberEmail,
      fileId,
      fileName,
      cleanAdmin,
      role,
      options
    );
    if (success) count++;
  }

  if (count > 0 && !options?.onlyIfMissingOrChanged) {
    log.info(`[ShareRelay] Đã tự động phát hành liên kết file cho ${count} tài khoản lên Firestore.`);
  }
  return count;
}

/**
 * Đảm bảo toàn bộ thành viên hợp lệ luôn có bản ghi fileId tồn tại và khớp trên Firestore
 * (tự phục hồi nếu thiếu mà không ghi đè thừa khi đã tồn tại).
 */
export async function ensureAssignedFilesPublishedForMembers(
  members: Array<{ email: string; role: string }>,
  fileId: string,
  fileName: string,
  adminEmail: string
): Promise<number> {
  return publishAssignedFilesForMembers(members, fileId, fileName, adminEmail, {
    onlyIfMissingOrChanged: true,
  });
}

/**
 * Thành viên tự động kiểm tra và nhận liên kết file từ Firestore.
 * QUAN TRỌNG: Không xóa bản ghi sau khi đọc để hỗ trợ đăng nhập đa thiết bị (Web, APK Android, thiết bị mới)
 * mà không phụ thuộc vào localStorage của thiết bị cũ.
 */
export async function consumeAssignedFileForMember(
  memberEmail: string
): Promise<AssignedShareRecord | null> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey || isDeviceOffline()) return null;

    const docRef = doc(getSharedFirestore(), 'assigned_shares', emailKey);
    const snap = await getDoc(docRef);

    if (!snap.exists()) {
      return null;
    }

    const data = snap.data() as AssignedShareRecord;
    if (!data || !data.assignedFileId) {
      log.warn(`[ShareRelay] Bản ghi ${emailKey} không hợp lệ hoặc thiếu assignedFileId`);
      return null;
    }

    log.info(`[ShareRelay] Nhận file_id cho ${memberEmail}: ${data.assignedFileId} (Tên: ${data.assignedFileName || 'Kho Sách'}, Vai trò: ${data.role})`);

    // Chỉ đọc bản ghi chuyển tiếp, KHÔNG xóa khi thành viên liên kết
    // để hỗ trợ đăng nhập tự động đa thiết bị (Điện thoại, Tablet, Web, cài lại app).
    // Bản ghi chỉ bị xóa qua removeAssignedFileForMember() khi Admin gỡ thành viên hoặc thu hồi quyền/hủy Workspace.
    return data;
  } catch (err: any) {
    const isOffline =
      err?.code === 'unavailable' ||
      err?.code === 'failed-precondition' ||
      /offline|unavailable|network|failed|internet/i.test(err?.message || '') ||
      (typeof navigator !== 'undefined' && !navigator.onLine);

    if (isOffline) {
      log.info('[ShareRelay] Thiết bị ngoại tuyến hoặc Firestore offline, bỏ qua kiểm tra relay tạm thời.');
    } else {
      log.warn('[ShareRelay] Lỗi kiểm tra liên kết chuyển tiếp từ Firestore:', err?.message || err);
    }
    return null;
  }
}

/**
 * CHỈ DÙNG KHI ADMIN XÓA THÀNH VIÊN HOẶC THU HỒI QUYỀN TRUY CẬP:
 * Xóa bản ghi chia sẻ của thành viên trên Firestore.
 */
export async function removeAssignedFileForMember(memberEmail: string): Promise<void> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey || isDeviceOffline()) return;
    publishedRelaySignatureCache.delete(emailKey);
    const docRef = doc(getSharedFirestore(), 'assigned_shares', emailKey);
    await deleteDoc(docRef);
    log.info(`[ShareRelay] Đã xóa bản ghi gán file cho ${memberEmail} trên Firestore`);
  } catch (err) {
    log.warn('[ShareRelay] Lỗi khi xóa bản ghi gán file:', err);
  }
}

/**
 * CHỈ DÙNG KHI ADMIN HỦY LIÊN KẾT WORKSPACE / THU HỒI TOÀN BỘ QUYỀN:
 * Xóa toàn bộ bản ghi chia sẻ của các thành viên trong Workspace trên Firestore.
 */
export async function removeAssignedFilesForWorkspace(
  _fileId: string,
  members: Array<{ email: string }>
): Promise<void> {
  try {
    for (const m of members) {
      if (m.email) {
        await removeAssignedFileForMember(m.email);
      }
    }
    log.info(`[ShareRelay] Đã dọn dẹp toàn bộ relay Firestore cho workspace.`);
  } catch (err) {
    log.warn('[ShareRelay] Lỗi dọn dẹp relay workspace:', err);
  }
}
