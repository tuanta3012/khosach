import { getApps, getApp, initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { log } from '../utils/logger';

// Khởi tạo an toàn Firestore instance dùng chung với database ID đã cấu hình
const getFirebaseApp = () => (getApps().length > 0 ? getApp() : initializeApp(firebaseConfig));
const db = getFirestore(getFirebaseApp(), 'ai-studio-khosach-0ef0f956-9e92-4b96-aab6-0adefe2a1acc');

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
  role: 'Owner' | 'Editor' | 'Viewer'
): Promise<boolean> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey || !fileId) return false;

    const docRef = doc(db, 'assigned_shares', emailKey);
    const data: AssignedShareRecord = {
      assignedFileId: fileId,
      assignedFileName: fileName || 'Kho Sách',
      adminEmail: adminEmail || '',
      memberEmail: memberEmail.trim().toLowerCase(),
      role,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await setDoc(docRef, data, { merge: true });
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
 * Admin phát hành liên kết file cho toàn bộ danh sách thành viên hiện tại và cho chính Admin
 */
export async function publishAssignedFilesForMembers(
  members: Array<{ email: string; role: string }>,
  fileId: string,
  fileName: string,
  adminEmail: string
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
      role
    );
    if (success) count++;
  }

  if (count > 0) {
    log.info(`[ShareRelay] Đã tự động phát hành liên kết file cho ${count} tài khoản lên Firestore.`);
  }
  return count;
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
    if (!emailKey) return null;

    const docRef = doc(db, 'assigned_shares', emailKey);
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

    // Chỉ đọc bản ghi chuyển tiếp, KHÔNG xóa ngay tại đây.
    // Bản ghi sẽ được xóa qua removeAssignedFileForMember() chỉ khi app đã hoàn tất liên kết thành công.
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
 * Xóa bản ghi chia sẻ khi Admin gỡ thành viên khỏi Workspace
 */
export async function removeAssignedFileForMember(memberEmail: string): Promise<void> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey) return;
    const docRef = doc(db, 'assigned_shares', emailKey);
    await deleteDoc(docRef);
    log.info(`[ShareRelay] Đã xóa bản ghi gán file cho ${memberEmail} trên Firestore`);
  } catch (err) {
    log.warn('[ShareRelay] Lỗi khi xóa bản ghi gán file:', err);
  }
}

/**
 * Đánh dấu hoặc xóa toàn bộ bản ghi chia sẻ khi Admin hủy liên kết Workspace
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
