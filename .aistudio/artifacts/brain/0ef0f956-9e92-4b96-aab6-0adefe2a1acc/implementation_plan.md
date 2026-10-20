# Kế hoạch Triển khai: Tự động Liên kết Tệp qua Firebase Firestore Relay cho Kho Sách (Zero-UI, 100% Ngầm)

Đặc tả này tập trung 100% vào cải tiến logic tầng nền (background services & synchronization logic). **Tuyệt đối không phát sinh bất kỳ giao diện người dùng (UI), modal hay nút bấm mới nào.** 

Kết quả cuối cùng: Thành viên chỉ cần đăng nhập tài khoản Google vào ứng dụng Kho sách (trên Web hoặc Android APK), tệp Google Sheet được Admin chia sẻ sẽ **tự động liên kết và đồng bộ sách ngay lập tức** mà người dùng không cần phải thực hiện bất kỳ thao tác thủ công nào.

---

### Xác nhận & Quyết định Then chốt (Confirmed Decisions)

> [!IMPORTANT]
> **Nguyên tắc "Zero-UI / Zero-Friction"**:
> - Không tạo bất kỳ màn hình, dialog xác nhận hay nút bấm chọn file nào cho thành viên.
> - Toàn bộ chu trình (Handshake) diễn ra tự động và âm thầm trong nền (background execution) ngay khi phiên đăng nhập hoàn tất.
> - Cơ sở dữ liệu: Sử dụng **Cloud Firestore** với cấu hình sẵn có của ứng dụng.
> - Cấu trúc: `assigned_shares/{sanitizedMemberEmail}` để thành viên tìm thấy ngay lập tức ($O(1)$) qua email của mình.
> - Cơ chế Tự Dọn Dẹp (Auto-Cleanup): Ngay khi thành viên mở app, lấy được file ID và lưu vào bộ nhớ cục bộ, app sẽ tự động gửi lệnh xóa tài liệu trên Firestore để bảo toàn dữ liệu và tối ưu chi phí.

---

### 1. Luồng Hoạt động Tự Động Hóa 100% (End-to-End Workflow)

```
[ADMIN]                                              [FIREBASE FIRESTORE]                            [THÀNH VIÊN]
  │                                                           │                                            │
  ├─ Thêm thành viên (luồng sẵn có)                           │                                            │
  │  (Gọi Drive Permission API)                               │                                            │
  ├─ Ghi ngầm dữ liệu chia sẻ ───────────────────────────────>│                                            │
  │  Doc: assigned_shares/{memberEmail}                       │                                            │
  │  Data: { assignedFileId, role, adminEmail, ... }          │                                            │
  │                                                           │                                            │
  │                                                           │                        Thành viên mở App & │
  │                                                           │                        đăng nhập thành công│
  │                                                           │                                            │
  │                                                           │<── Auto-check ngầm theo email ─────────────┤
  │                                                           │    (Ngay trong hook initAuth của App.tsx)  │
  │                                                           │                                            │
  │                                                           ├─── Trả về assignedFileId ─────────────────>│
  │                                                           │                                            │
  │                                                           │                                            ├─ Lưu con trỏ Master file
  │                                                           │                                            │  vào LocalStorage
  │                                                           │                                            │
  │                                                           │<── Gửi lệnh xóa bản ghi (deleteDoc) ───────┤
  │                                                           │    (Dọn dẹp sạch Firestore tức thì)        │
  │                                                           │                                            │
  │                                                           │                                            ├─ Tự động nạp toàn bộ sách
  │                                                           │                                            │  về máy (syncBooksTwoWay)
  │                                                           │                                            │
  ▼                                                           ▼                                            ▼
 (Không có UI mới)                                   (Không lưu vết dư thừa)                      (Sách đã sẵn sàng hiển thị!)
```

---

### 2. Chi tiết Cải tiến Kỹ thuật (Technical Implementation)

#### 2.1 Module Xử lý Ngầm: `src/services/firebaseShareRelayService.ts`
Chịu trách nhiệm toàn bộ việc giao tiếp với Firestore cho luồng chuyển tiếp file:
1. `sanitizeEmailKey(email: string): string`: Chuẩn hóa email thành Document ID hợp lệ cho Firestore (chữ thường, thay ký tự không hợp lệ bằng ký tự an toàn).
2. `publishAssignedFile(memberEmail: string, fileId: string, fileName: string, adminEmail: string, role: 'Editor' | 'Viewer')`:
   - Admin gọi ngầm khi thêm thành viên.
   - Ghi vào collection `assigned_shares/{sanitizedEmail}` với các trường:
     `{ assignedFileId, assignedFileName, adminEmail, memberEmail, role, createdAt }`.
3. `consumeAssignedFileForMember(memberEmail: string)`:
   - Thành viên gọi ngầm ngay khi đăng nhập.
   - Kiểm tra xem có document cho `sanitizedEmail` không.
   - **Nếu tìm thấy**:
     - Lấy `assignedFileId`, `role`, `assignedFileName`.
     - Lập tức thực thi `deleteDoc` để xóa bản ghi chia sẻ khỏi Firestore.
     - Trả kết quả về cho ứng dụng xử lý tiếp.
   - **Xử lý ngoại lệ an toàn**: Luôn bọc trong `try-catch`, nếu gặp lỗi mạng hoặc Firestore tạm thời gián đoạn thì không bao giờ làm gián đoạn hay crash app (Local-first).

#### 2.2 Tích hợp vào Luồng Thêm Thành viên của Admin (`FamilyShareModal.tsx`)
- Không thay đổi giao diện form hay bảng danh sách thành viên hiện có.
- Trong hàm `handleAddMember`, sau khi hàm `addFamilyMember` (Google Drive API) hoàn tất thành công:
  - Gọi ngầm `publishAssignedFile(email, sheetId, spreadsheetInfo?.name || 'Kho Sách', currentUser.email, roleInput)`.
  - Nếu xảy ra lỗi mạng với Firestore, ghi log cảnh báo và không làm ảnh hưởng đến kết quả cấp quyền Drive.

#### 2.3 Tích hợp Tự động Liên kết & Nạp Sách trong `App.tsx`
- Trong hàm callback `initAuth` (chạy ngay khi người dùng đăng nhập tài khoản Google thành công):
  - Trước khi thực hiện bất kỳ hành động nào khác, gọi ngầm `consumeAssignedFileForMember(user.email)`.
  - Nếu trả về thông tin `assignedFileId`:
    1. Gán `SpreadsheetInfo` vào con trỏ master:
       - Cập nhật state `spreadsheetInfo`
       - Lưu `library_spreadsheet_info_v2` và cập nhật `known_spreadsheets` trong `localStorage`
       - Xóa cờ `unlinked_spreadsheet_explicitly` nếu có
    2. Cập nhật vai trò người dùng tương ứng (`ADMIN`, `EDITOR`, hoặc `VIEWER`).
    3. Ngay lập tức kích hoạt `syncBooksTwoWay` để kéo toàn bộ sách từ Google Sheet về máy thành viên.
    4. Hiển thị thông báo Toast ngắn gọn báo hiệu trạng thái sẵn sàng: *"✨ Đã kết nối với kho sách được chia sẻ!"*.

#### 2.4 Cập nhật Blueprint & Quy tắc Bảo mật Firestore
- Cập nhật `firebase-blueprint.json` bổ sung schema `AssignedShare`.
- Cập nhật `firestore.rules`:
  - Cho phép người dùng đọc và xóa document trong `assigned_shares` nếu liên quan đến email của họ.
  - Cho phép người dùng đã đăng nhập ghi document `assigned_shares` khi chia sẻ file.

---

### 3. Kế hoạch Thực hiện

1. **Bước 1**: Tạo file `src/services/firebaseShareRelayService.ts` với đầy đủ logic ghi, đọc và tự xóa (`deleteDoc`), kiểm soát lỗi try-catch tuyệt đối.
2. **Bước 2**: Gắn lệnh gọi ngầm `publishAssignedFile` vào `FamilyShareModal.tsx` khi Admin thêm thành viên.
3. **Bước 3**: Gắn lệnh tự động kiểm tra `consumeAssignedFileForMember` và nạp sách ngay khi khởi động phiên trong `App.tsx`.
4. **Bước 4**: Cập nhật `firebase-blueprint.json` và `firestore.rules`.
5. **Bước 5**: Kiểm tra biên dịch mã nguồn với `compile_applet` để đảm bảo 100% không có lỗi type/lint, build sẵn sàng cho Web và APK Android.
