# Kế hoạch Bảo vệ Tuyệt đối Master Data Google Drive & Chuẩn hóa Log Kiểm toán

## Tóm tắt mục tiêu
Kế hoạch khắc phục triệt để lỗi ghi đè/mất dữ liệu trên Google Drive khi cài lại app hoặc mở app mới, đảm bảo cơ chế **Pull-Only (Chỉ đọc)** khi nạp dữ liệu, cấm hoàn toàn mọi hành vi tự động Push đè file gốc khi chưa đồng bộ xong; đồng thời hợp nhất hệ thống log kiểm toán thành **1 bản ghi duy nhất** kèm chi tiết lệnh, vai trò và phạm vi tác dụng.

---

## Các quyết định quan trọng đã xác nhận

> [!IMPORTANT]
> - **Nguyên tắc Master Data**: Khi mở app, đổi file hoặc cài lại app $\rightarrow$ Luôn ưu tiên **Pull toàn bộ dữ liệu từ Google Drive về máy**, thay thế sạch sẽ dữ liệu cục bộ; **nghiêm cấm mọi hành vi tự động Push** khi chưa tải xong dữ liệu gốc.
> - **Loại bỏ Push ngầm khi Pull**: Xóa bỏ hoàn toàn đoạn mã tự động ghi đè ngược lên Drive (`updateRealGoogleDriveFile`) trong quá trình tải (`downloadRealGoogleDriveFile` / `syncBooksFromDrive`). Quá trình đọc file phải là **Read-Only 100%**.
> - **Khóa bảo vệ (Sync Lock)**: Khi `isInitialSyncDoneRef` chưa hoàn tất $\rightarrow$ Chặn đứng tất cả các trigger auto-push từ `useEffect` và `useSavingsBooks`.
> - **Hợp nhất Log Kiểm toán**: Gộp log tải dữ liệu thành **1 bản ghi duy nhất** (xóa bỏ log trùng lặp giữa `googleDriveService` và `useDriveSync`), ghi chính xác vai trò người dùng (`ADMIN` / `VIEWER`), thiết bị (`Web` / `Android`) và liệt kê chi tiết danh sách sổ cùng số tiền bị tác động.

---

## 1. Kiến trúc luồng đồng bộ an toàn (Safe Data Flow)

```
[Mở App / Cài lại APK]
        │
        ▼
[1. KHÓA TẤT CẢ PUSH] ─── (isInitialSyncDoneRef = false, cấm ghi đè)
        │
        ▼
[2. PULL TỪ GOOGLE DRIVE] ─── (Read-Only 100%, không ghi ngược)
        │
        ├─► Nạp đầy đủ danh sách Sổ Tiết Kiệm vào App
        ├─► Nạp đầy đủ Nhật ký Tất toán vào App
        └─► Ghi 1 LOG DUY NHẤT: SYNC_PULL (Đầy đủ số lượng & danh sách mã sổ)
        │
        ▼
[3. MỞ KHÓA PUSH] ─── (isInitialSyncDoneRef = true)
        │
        ▼
[CHỈ PUSH KHI NGƯỜI DÙNG THAO TÁC BẤM NÚT THỰC SỰ]
(Thêm sổ / Sửa sổ / Xóa sổ / Tất toán / Tái tục)
```

---

## 2. Kế hoạch triển khai chi tiết

### 2.1. Triệt tiêu nguy cơ ghi đè dữ liệu Drive khi khởi động & tải file (`useDriveSync.ts`)
- **Loại bỏ hoàn toàn auto-push trong hàm Pull**:
  - Gỡ bỏ điều kiện `if ((pushAfterSync || hasEmptyCalculatedColumns) && ...)` trong `syncBooksFromDrive` vốn tự động gọi `updateRealGoogleDriveFile` khi vừa đọc file xong.
- **Khóa an toàn tuyệt đối khi khởi động**:
  - Đảm bảo `isInitialSyncDoneRef.current = false` ngay khi ứng dụng mount và chỉ chuyển sang `true` khi đã hoàn tất `downloadRealGoogleDriveFile` thành công.
  - Trong `useEffect` auto-push và callback `onPushToDrive`: Chặn tuyệt đối nếu `isInitialSyncDoneRef.current === false`.
- **Bảo toàn dữ liệu khi nạp từ Drive**:
  - Dữ liệu từ file Google Drive (active books + settlements) là nguồn sự thật duy nhất ghi đè vào state máy và `localStorage`, xóa sạch các dữ liệu rác/mẫu còn lưu ở máy cũ.

### 2.2. Hợp nhất và chuẩn hóa hệ thống Log Kiểm toán (`syncAuditLog.ts`, `googleDriveService.ts`, `useDriveSync.ts`)
- **Xóa bỏ log đúp**: Xóa lệnh `recordSyncAuditLog` trùng lặp trong tầng thấp `googleDriveService.ts`, chỉ giữ lại 1 bản ghi duy nhất tại tầng điều phối `useDriveSync.ts`.
- **Ghi chính xác vai trò**: Xác định đúng `role` (`ADMIN` nếu email trùng chủ sở hữu workspace / file, hoặc `VIEWER` nếu là thành viên chỉ xem).
- **Chi tiết hóa phạm vi tác dụng trong log**:
  - Ghi rõ lệnh: `SYNC_PULL` (Tải từ Drive) hoặc `SYNC_PUSH` (Đẩy lên Drive).
  - Chi tiết hóa danh sách mã sổ bị tác động (Mã sổ, Ngân hàng, Tiền gốc Tr VNĐ, Ngày đáo hạn).
  - Chi tiết hóa nhật ký tất toán (Mã sổ, Ngày tất toán, Tiền lãi thực nhận).

---

## 3. Kiểm thử & Xác minh
- Kiểm tra kịch bản mở app lần đầu / cài mới APK: Xác nhận app chỉ thực hiện PULL dữ liệu từ Drive về máy, không phát sinh bất kỳ lệnh PUSH nào lên file Drive.
- Kiểm tra chỉnh sửa 1 sổ: Xác nhận log ghi nhận đúng 1 bản ghi `SYNC_PUSH` với chi tiết nội dung thay đổi.
- Kiểm tra danh sách log trong `AuditLogModal`: Xác nhận không còn tình trạng log bị đúp 2 dòng hay sai vai trò.
