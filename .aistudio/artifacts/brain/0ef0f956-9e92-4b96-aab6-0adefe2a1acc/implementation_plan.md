# Chuẩn Hóa Cấu Trúc Tab __CONFIG__ (Không Audit Logs) & Cơ Chế Tự Động Liên Kết Workspace

## Tóm tắt mục tiêu
Sửa đổi toàn diện cơ chế ghi và đọc dữ liệu cấu hình Workspace lên tab ẩn `__CONFIG__` trên Google Sheet theo đúng cấu trúc Key-Value chuẩn từ `/googleDriveService.ts`, **hoàn toàn loại bỏ phần ghi nhật ký Audit Logs** để bảng tính nhẹ nhàng, tối ưu tốc độ và không dư thừa dữ liệu. Giải quyết dứt điểm lỗi tài khoản User B không tự động tìm thấy và đọc được file liên kết A khi được Admin chia sẻ.

---

## 1. Cấu trúc tinh gọn của Tab Ẩn `__CONFIG__` (Dải ô A1:B10 - Đã loại bỏ Audit Logs)

Bảng cấu hình được tinh gọn thành 10 hàng x 2 cột (Key-Value), không lưu trữ Audit Logs:

| Hàng | Cột A (Key) | Cột B (Value) | Mô tả chi tiết |
|:---|:---|:---|:---|
| **1** | `__METADATA_JSON__` | Chuỗi JSON Core Meta | Chứa `schemaVersion: 2`, `status`, `lastAction`, `activeFileId`, `activeFileName`, `activeFileUrl`, `adminEmail`, `linkedAccountEmail`, `linkedTimestamp`, `linkedLocalTimeVi`, `updatedAt`, `updatedAtVi` |
| **2** | `Vault Name` | Tên kho sách | Ví dụ: "Kho Sách Gia Đình" |
| **3** | `Admin Email` | Email Quản trị viên | Email chủ sở hữu không gian Workspace |
| **4** | `Linked Account` | Email tài khoản liên kết | Email thực hiện liên kết tệp |
| **5** | `Status` | `active` / `unlinked` | Trạng thái hoạt động của Workspace |
| **6** | `Last Action` | `link` / `switch` / `unlink` / `create_and_link` | Hành động mới nhất trên Workspace |
| **7** | `Linked Timestamp` | Ngày giờ liên kết VN | Định dạng: `HH:mm:ss DD/MM/YYYY (GMT+7)` |
| **8** | `Updated At` | Ngày giờ cập nhật VN | Định dạng: `HH:mm:ss DD/MM/YYYY (GMT+7)` |
| **9** | `Members JSON` | Chuỗi JSON Mảng thành viên | `[{ id, email, name, role: 'ADMIN'\|'EDITOR'\|'VIEWER', addedAt, addedBy, avatarUrl }]` |
| **10** | `Custom Settings` | Chuỗi JSON Thiết lập ứng dụng | Cặp sách đã bỏ qua (`ignoredDuplicatePairs`), danh mục tùy chỉnh |

---

## 2. Kế hoạch sửa đổi chi tiết

### Bước 1: Loại bỏ toàn bộ code và logic liên quan đến Audit Logs
- Trong `driveSyncService.ts`:
  - Loại bỏ trường `auditLog` khỏi `SheetConfigMetadata` và các hàm lưu trạng thái.
  - Xóa bỏ việc đọc, ghi, hoặc lưu trữ Audit Logs trong tab `__CONFIG__` hoặc LocalStorage.
  - Tinh gọn payload ghi Sheet về dải ô `__CONFIG__!A1:B10`.

### Bước 2: Chuẩn hóa hàm ghi `saveMasterSyncStateToGoogleSheet`
- Ghi ma trận 10 hàng x 2 cột (`__CONFIG__!A1:B10`) lên Google Sheet qua Sheets API v4.
- Tự động tạo tab `__CONFIG__` (ẩn) qua request `addSheet` nếu gặp mã `HTTP 400` do tab chưa tồn tại, sau đó thử ghi lại ngay lập tức.

### Bước 3: Chuẩn hóa hàm đọc `readMasterSyncStateFromGoogleSheet`
- Đọc dải ô `__CONFIG__!A1:B20` bằng Google Sheets API v4.
- Duyệt qua các hàng, đưa vào `kvMap` và giải mã JSON của `__METADATA_JSON__` và `Members JSON`.
- Giữ cơ chế tương thích ngược (Backward Compatibility): Nếu tệp cũ có tab `Config` (dải `A:C` và `E1:F10`), hàm vẫn tự động đọc bình thường để không làm gián đoạn các bảng tính đã tạo trước đây.

### Bước 4: Sửa lỗi truy vấn quét file trên Google Drive
- Áp dụng phương thức truy vấn chuẩn từ `listRealGoogleDriveFiles` trong `/googleDriveService.ts`:
  - `url.searchParams.set('q', "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'");`
  - `url.searchParams.set('spaces', 'drive');`
  - `url.searchParams.set('orderBy', 'modifiedTime desc');`
  - Loại bỏ hoàn toàn các cờ xung đột như `includeItemsFromAllDrives: 'true'` khi tìm kiếm để không bị Google Drive API từ chối với lỗi `HTTP 400 Bad Request`.

### Bước 5: Tự động phát hiện và liên kết khi User B đăng nhập (`autoDiscoverSharedSpreadsheets` & `App.tsx`)
- Khi User B đăng nhập Google:
  1. Quét danh sách Google Sheet khả dụng qua Drive API v3.
  2. Với từng file, gọi `readMasterSyncStateFromGoogleSheet`.
  3. Kiểm tra điều kiện:
     - `status === 'active'`
     - Email của User B trùng với `adminEmail` HOẶC nằm trong `members` với vai trò `ADMIN`, `EDITOR` hoặc `VIEWER`.
  4. Nếu tìm thấy File A:
     - Tự động gán `spreadsheetInfo` trỏ về File A.
     - Lưu thông tin file vào LocalStorage (`library_spreadsheet_info_v2`).
     - Cập nhật vai trò người dùng trong ứng dụng (ví dụ: `EDITOR`).
     - Kích hoạt đồng bộ 2 chiều `syncBooksTwoWay` nạp ngay toàn bộ sách từ File A về máy.
     - Hiển thị Toast thông báo: *"Đã tự động kết nối với Tủ sách gia đình (Quyền Chỉnh sửa)"*.

### Bước 6: Quản lý thành viên & Hủy liên kết (Unlink)
- `addFamilyMember`: Thêm thành viên vào mảng `members`, ghi lên ô B9 `Members JSON` của tab `__CONFIG__`, đồng thời gọi Drive API cấp quyền `writer` (nếu là `EDITOR`) hoặc `reader` (nếu là `VIEWER`).
- `removeFamilyMember`: Cập nhật lại mảng `members` trên tab `__CONFIG__` và gọi Drive API `DELETE /permissions/{id}`.
- `setMasterSyncUnlinked`: Khi Admin hủy liên kết, ghi `status: 'unlinked'`, `lastAction: 'unlink'` lên Google Sheet và thu hồi toàn bộ quyền Drive của thành viên. Khi thiết bị thành viên phát hiện `status === 'unlinked'`, tự động ngắt kết nối và bảo vệ dữ liệu.

---

## 3. Kế hoạch kiểm tra & Xác minh (Verification Plan)

1. **Kiểm tra cú pháp & biên dịch**: Chạy `compile_applet` để xác minh toàn bộ mã nguồn TypeScript build thành công 0 lỗi.
2. **Kiểm tra tab `__CONFIG__`**: Đảm bảo dải ô `A1:B10` không còn bất kỳ trường audit logs nào, dữ liệu ghi ngắn gọn, chính xác.
3. **Kiểm tra luồng Auto-Discovery**: Đảm bảo truy vấn Drive API hoạt động mượt mà và tự động nhận diện quyền Editor của User B.
