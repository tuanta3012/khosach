import { getApps, getApp, initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

// Khởi tạo an toàn Firestore instance dùng chung
const getFirebaseApp = () => (getApps().length > 0 ? getApp() : initializeApp(firebaseConfig));
const db = getFirestore(getFirebaseApp());

export interface AssignedShareRecord {
  assignedFileId: string;
  assignedFileName?: string;
  adminEmail: string;
  memberEmail: string;
  role: 'Editor' | 'Viewer';
  createdAt: number;
  updatedAt: number;
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
 * Admin phát hành liên kết file lên Firestore khi thêm thành viên mới
 */
export async function publishAssignedFile(
  memberEmail: string,
  fileId: string,
  fileName: string,
  adminEmail: string,
  role: 'Editor' | 'Viewer'
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await setDoc(docRef, data, { merge: true });
    console.info(`[ShareRelay] Đã phát hành liên kết file ${fileId} cho ${memberEmail} lên Firestore (key: ${emailKey})`);
    return true;
  } catch (err: any) {
    const isOffline =
      err?.code === 'unavailable' ||
      err?.code === 'failed-precondition' ||
      /offline|unavailable|network|failed|internet/i.test(err?.message || '') ||
      (typeof navigator !== 'undefined' && !navigator.onLine);

    if (isOffline) {
      console.info('[ShareRelay] Thiết bị đang ngoại tuyến, không thể ghi liên kết file lên Firestore.');
    } else {
      console.warn('[ShareRelay] Ghi liên kết file lên Firestore thất bại:', err?.message || err);
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
  adminEmail: string
): Promise<number> {
  if (!fileId || !Array.isArray(members) || members.length === 0) return 0;
  const cleanAdmin = (adminEmail || '').trim().toLowerCase();
  let count = 0;

  for (const m of members) {
    const cleanMemberEmail = (m.email || '').trim().toLowerCase();
    if (!cleanMemberEmail || cleanMemberEmail === cleanAdmin || m.role === 'Owner') {
      continue;
    }
    const role: 'Editor' | 'Viewer' = m.role === 'Editor' ? 'Editor' : 'Viewer';
    const success = await publishAssignedFile(
      cleanMemberEmail,
      fileId,
      fileName,
      adminEmail,
      role
    );
    if (success) count++;
  }

  if (count > 0) {
    console.info(`[ShareRelay] Đã tự động phát hành liên kết file cho ${count} thành viên trong workspace.`);
  }
  return count;
}

/**
 * Thành viên tự động kiểm tra và tiêu thụ liên kết file khi mở phiên:
 * - Đọc thông tin assignedFileId
 * - Xóa ngay lập tức bản ghi trên Firestore để dữ liệu luôn sạch
 * - Trả về dữ liệu để app lưu cục bộ và bắt đầu đồng bộ
 */
export async function consumeAssignedFileForMember(
  memberEmail: string
): Promise<AssignedShareRecord | null> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey) return null;

    console.info(`[ShareRelay] Đang kiểm tra liên kết chuyển tiếp Firestore cho ${memberEmail} (key: ${emailKey})...`);
    const docRef = doc(db, 'assigned_shares', emailKey);
    const snap = await getDoc(docRef);

    if (!snap.exists()) {
      console.info(`[ShareRelay] Không có bản ghi chuyển tiếp chờ nhận cho key: ${emailKey}`);
      return null;
    }

    const data = snap.data() as AssignedShareRecord;
    if (!data || !data.assignedFileId) {
      console.warn(`[ShareRelay] Bản ghi ${emailKey} không hợp lệ hoặc thiếu assignedFileId`);
      return null;
    }

    console.info(`[ShareRelay] NHẬN ĐƯỢC assignedFileId cho ${memberEmail}: ${data.assignedFileId} (Admin: ${data.adminEmail || 'Unknown'})`);

    // Dọn dẹp bản ghi tức thì trên Firestore theo đúng yêu cầu
    try {
      await deleteDoc(docRef);
      console.info(`[ShareRelay] Đã xóa thành công bản ghi chuyển tiếp của ${memberEmail} trên Firestore`);
    } catch (delErr) {
      console.warn('[ShareRelay] Lỗi khi dọn dẹp bản ghi chuyển tiếp trên Firestore:', delErr);
    }

    return data;
  } catch (err: any) {
    const isOffline =
      err?.code === 'unavailable' ||
      err?.code === 'failed-precondition' ||
      /offline|unavailable|network|failed|internet/i.test(err?.message || '') ||
      (typeof navigator !== 'undefined' && !navigator.onLine);

    if (isOffline) {
      console.info('[ShareRelay] Thiết bị đang ngoại tuyến hoặc Firestore client offline, bỏ qua kiểm tra relay tạm thời.');
    } else {
      console.warn('[ShareRelay] Lỗi kiểm tra liên kết chuyển tiếp từ Firestore:', err?.message || err);
    }
    return null;
  }
}

/**
 * Xóa bản ghi chia sẻ khi Admin gỡ thành viên (nếu bản ghi còn tồn tại)
 */
export async function removeAssignedFileForMember(memberEmail: string): Promise<void> {
  try {
    const emailKey = sanitizeEmailKey(memberEmail);
    if (!emailKey) return;
    const docRef = doc(db, 'assigned_shares', emailKey);
    await deleteDoc(docRef);
    console.info(`[ShareRelay] Đã xóa bản ghi gán file cho ${memberEmail}`);
  } catch (err) {
    console.warn('[ShareRelay] Lỗi khi xóa bản ghi gán file:', err);
  }
}
