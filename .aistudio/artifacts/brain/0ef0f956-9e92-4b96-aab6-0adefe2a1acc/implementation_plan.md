# KẾ HOẠCH TRIỂN KHAI: ỨNG DỤNG QUẢN LÝ & TRA CỨU KHO SÁCH CÁ NHÂN (2.000+ CUỐN)

## 1. Mục Tiêu & Định Hướng Kiến Trúc
Chuyển đổi toàn diện codebase hiện tại từ Sổ Tiết Kiệm sang **Ứng dụng Quản lý & Tra cứu Kho Sách Cá Nhân** chuẩn theo tài liệu đặc tả (Specification):
- **Quy mô dữ liệu**: Tối ưu cho danh mục 2.000+ cuốn sách giấy Việt Nam, 100% dữ liệu Text/Numeric siêu nhẹ (không lưu blob/ảnh vào DB).
- **Core Engine Bảng Kê**: Tích hợp `@tanstack/react-table` (v8) hiển thị mật độ thông tin cao, cuộn mượt mà, hỗ trợ sắp xếp đa tiêu chí (Multi-level sorting: Vị trí -> Tác giả -> Tên sách), tìm kiếm tức thì không dấu Tiếng Việt và sửa trực tiếp (Inline Edit).
- **AI Vision Batch Scanner**: Sử dụng `gemini-2.5-flash` qua `@google/genai` để đọc ảnh gáy sách/trang phụ hàng loạt, trích xuất JSON `[{"title": string, "author": string, "publisher": string}]`, ngay lập tức giải phóng Base64 khỏi RAM, kiểm tra trùng lặp Fuzzy Matching (title + author), hỗ trợ nút làm giàu dữ liệu (Data Enrichment), gán nhanh Vị trí lưu trữ và lưu vào Firestore.
- **Lưu trữ & Đồng bộ**: Firebase Firestore (Offline-first, thời gian thực) + Google Drive Backup/Restore (Xuất/nhập file JSON/CSV).
- **Kế thừa & Tương thích**: Giữ nguyên nền tảng Capacitor Android APK (Status Bar, Safe Area, Icons, GitHub Actions build APK tự động).

---

## 2. Thiết Kế Cơ Sở Dữ Liệu & Schema (100% Text/Numeric)

```typescript
export interface BookRecord {
  id: string;                 // UUID / Firestore Doc ID
  title: string;              // Tên sách (Bắt buộc)
  author: string;             // Tác giả (Bắt buộc)
  publisher: string;          // Nhà xuất bản / Nguồn gốc
  publish_year?: number;      // Năm xuất bản
  category?: string;          // Thể loại (Văn học, Kinh tế, Lịch sử, Kỹ năng,...)
  location: string;           // Vị trí lưu trữ (Ví dụ: Kệ A-1, Tủ P.Khách, Hộp B-2)
  status: 'IN_STOCK' | 'BORROWED' | 'LOST'; // Trạng thái tồn tại
  borrower_note?: string;     // Ghi chú mượn (Ví dụ: Nam mượn ngày 12/10)
  notes?: string;             // Ghi chú thêm (Tái bản, tình trạng sách...)
  created_at: number;         // Epoch Timestamp (ms)
  updated_at: number;         // Epoch Timestamp (ms)
}

export interface StagingDraftBook {
  tempId: string;
  title: string;
  author: string;
  publisher: string;
  publish_year?: number;
  category?: string;
  location: string;
  status: 'IN_STOCK' | 'BORROWED' | 'LOST';
  isDuplicate?: boolean;
  duplicateMatchedWith?: string; // Tên sách trùng lặp gợi ý
  enrichmentLoading?: boolean;
}
```

---

## 3. Các Mô-đun Tính Năng Chi Tiết

### A. Mô-đun Bảng Kê Kho Dữ Liệu Cao (TanStack Table View)
1. **Bảng dữ liệu mật độ cao (Dense Data Table)**:
   - Cột: STT, Tên sách, Tác giả, Nhà xuất bản / Năm, Thể loại, Vị trí lưu trữ (Badge màu), Trạng thái (Trong kho / Đang mượn / Thất lạc), Ghi chú / Người mượn, Thao tác.
   - Sắp xếp đa tầng (Multi-sort): Nhấp hoặc cấu hình nhiều cấp sắp xếp ưu tiên (Vị trí A-Z ➔ Tác giả A-Z ➔ Tên sách A-Z).
   - Lọc phân loại nhanh: Lọc theo Vị trí (Kệ/Tủ), Trạng thái tồn tại, Thể loại.
   - Sửa nhanh tại chỗ (Inline Edit): Bấm sửa nhanh Vị trí hoặc Trạng thái mượn/trả trực tiếp trên dòng dữ liệu mà không cần mở modal lớn.
2. **Tìm kiếm thông minh toàn diện (Smart Search)**:
   - Chuẩn hóa tiếng Việt không dấu (bỏ dấu tiếng Việt, xử lý chữ hoa/thường) tìm kiếm tức thì trên toàn bộ các trường: Tên sách, Tác giả, NXB, Thể loại, Vị trí.
   - Thống kê nhanh: Tổng số đầu sách, số lượng theo kệ/vị trí, số sách đang cho mượn, số thể loại.

### B. Mô-đun Nhập Liệu AI Vision & Bảng Chờ Duyệt (Batch Scanner & Staging Draft)
1. **Thu thập ảnh linh hoạt**:
   - Chụp ảnh trực tiếp từ Camera thiết bị (chụp liên tục nhiều gáy sách).
   - Chọn đồng thời nhiều ảnh từ Thư viện (Gallery / Files).
   - Xem thumbnail tạm thời trong phiên làm việc.
2. **AI Vision Parsing (Gemini 2.5 Flash)**:
   - Gửi payload mảng ảnh Base64 lên Gemini 2.5 Flash với prompt ép cấu trúc JSON nghiêm ngặt bóc tách gáy sách và trang bìa lót/phụ.
   - Giải phóng 100% mảng ảnh Base64 khỏi RAM ngay khi nhận phản hồi để giữ bộ nhớ thiết bị nhẹ và an toàn.
3. **Kiểm tra trùng lặp (Fuzzy Matching)**:
   - Sử dụng thuật toán so khớp chuỗi gần đúng (Levenshtein / Dice Coefficient trên chuỗi không dấu chuẩn hóa) đối chiếu với kho sách hiện tại trong CSDL.
   - Gắn cờ cảnh báo đỏ nếu phát hiện sách đã tồn tại hoặc gần giống để tránh lưu trùng.
4. **Làm giàu dữ liệu AI (Data Enrichment)**:
   - Nút "Tìm kiếm & Bổ sung thông tin": Tự động tra cứu thể loại, năm xuất bản, chuẩn hóa tên tác giả/nhà xuất bản chính xác cho từng cuốn hoặc toàn bộ bảng chờ.
5. **Gán vị trí hàng loạt & Lưu chính thức**:
   - Gán vị trí mặc định nhanh (Batch Apply Location) cho tất cả sách vừa quét (ví dụ: Kệ B-3).
   - Tinh chỉnh thông tin từng dòng trước khi nhấn **"Xác nhận lưu vào Kho"** đẩy vào Firestore.

### C. Quản Lý Thêm/Sửa Thủ Công & Cho Mượn Sách
- Modal Thêm mới / Chỉnh sửa chi tiết một cuốn sách với danh sách gợi ý vị trí và thể loại có sẵn.
- Trình quản lý cho mượn / trả sách nhanh: Ghi chú người mượn, ngày mượn, cập nhật trạng thái `BORROWED` / `IN_STOCK`.

### D. Đồng Bộ & Sao Lưu (Sync & Backup)
- **Firebase Firestore**: Lưu trữ thời gian thực, tự động cache offline.
- **Google Drive REST API**: Xuất/Nhập file `.json` hoặc `.csv` sao lưu toàn bộ danh mục kho sách lên Google Drive cá nhân của người dùng.
- **Xuất file Excel / CSV**: Hỗ trợ xuất bảng thống kê kiểm kê kho đầy đủ cột.

### E. Giao Diện & Tối Ưu Mobile Native (Capacitor)
- Giao diện thiết kế phẳng, tông màu tinh tế, hiện đại (Emerald/Slate), chuẩn Touch-friendly.
- Tương thích hoàn toàn Capacitor Android APK: Giữ cấu hình StatusBar, Safe Area, Icons, GitHub Actions workflow build file APK.

---

## 4. Kế Hoạch Triển Khai Từng Bước
1. **Cài đặt thư viện bổ sung**: Cài đặt `@tanstack/react-table` và `@google/genai` phục vụ Data Table View và Gemini Vision bóc tách gáy sách.
2. **Cập nhật Types & Schema**: Định nghĩa cấu trúc `BookRecord`, `StagingDraftBook`, `LibraryStats` tại `src/types.ts`.
3. **Xây dựng Services**:
   - `src/services/geminiBookVisionService.ts`: Xử lý AI Vision đọc gáy sách, parsing JSON chuẩn và giải phóng RAM.
   - `src/services/fuzzyMatchService.ts`: Thuật toán so sánh chuỗi trùng lặp không dấu.
   - `src/services/bookFirestoreService.ts`: CRUD và Realtime sync Firestore cho kho sách.
   - `src/services/bookDriveBackupService.ts`: Xuất/nhập file JSON sao lưu Google Drive.
4. **Xây dựng Components**:
   - `BookTableView.tsx`: Bảng kê TanStack Table với Multi-sorting, Global Search tiếng Việt không dấu, Inline Edit, Filter bar.
   - `BatchScanner.tsx`: Luồng chụp/import nhiều ảnh, gọi Gemini Vision, Bảng chờ duyệt (Draft Table), Fuzzy Match cảnh báo trùng, Data Enrichment, gán vị trí hàng loạt.
   - `BookDetailModal.tsx` & `AddEditBookModal.tsx`: Xem chi tiết, sửa sách, quản lý cho mượn.
   - `DriveBackupModal.tsx`: Sao lưu và phục hồi JSON qua Google Drive.
   - `LibraryStatsBar.tsx`: Thanh thống kê tổng quan (Tổng số sách, vị trí, sách đang mượn).
5. **Tích hợp App.tsx & Kiểm tra Compile**:
   - Cập nhật Navbar, kết nối các tab: **Kho Sách (Bảng Kê)**, **Nhập Liệu AI Vision**, **Thống Kê Vị Trí**, **Sao Lưu & Đồng Bộ**.
   - Chạy `compile_applet` để đảm bảo không có lỗi TypeScript hay build error.
