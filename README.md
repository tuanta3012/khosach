# KHO SÁCH - TÀI LIỆU BÀN GIAO DỰ ÁN CHO AGENT
Ngày đối chiếu mã nguồn: 2026-10-15  
Ngôn ngữ giao diện, chú thích và nghiệp vụ: Tiếng Việt.

---

## MỤC ĐÍCH TÀI LIỆU

Đây là bản đồ kỹ thuật thực tế của dự án **Kho Sách (Vietnamese Personal & Family Library Manager)**, dành riêng cho kỹ sư phần mềm hoặc AI Agent tiếp nhận và phát triển tiếp hệ thống. Hãy đọc kỹ tài liệu này trước khi tiến hành chỉnh sửa mã nguồn, mô hình dữ liệu, cơ chế đăng nhập Google, thuật toán đồng bộ Google Drive/Sheets, phân quyền gia đình hoặc quy trình đóng gói phát hành Android.

Nội dung tài liệu phản ánh chính xác cấu trúc mã nguồn đang thực thi, không phải dự tính tương lai. Nếu bất kỳ chú thích cũ nào trong mã nguồn mâu thuẫn với hành vi thực thi thực tế, hãy ưu tiên hành vi thực thi và kiểm thử thực tế.

---

## 1. TỔNG QUAN SẢN PHẨM

**"Kho Sách"** là ứng dụng di động (Android-first qua Capacitor) và Web SPA hỗ trợ cá nhân và hộ gia đình quản lý toàn diện thư viện sách trong nhà. Người dùng có thể:
- Quản lý danh mục sách: Tên sách, Tác giả, Thể loại (Văn học, Kinh tế, Lịch sử, Khoa học...), Nhà xuất bản, Năm xuất bản, Tóm tắt nội dung.
- Quét thông minh bằng AI (Gemini Flash OCR): Chụp ảnh bìa sách hoặc gáy sách hàng loạt từ camera thiết bị, tự động cắt ảnh (Image Crop), nhận diện văn bản đa góc độ và trích xuất thông tin sách tự động.
- Tự động làm giàu dữ liệu (Book Enrichment): Kết nối đối chiếu qua Google Books API và Open Library API để chuẩn hóa tên tác giả, thể loại và bổ sung ảnh bìa, tóm tắt.
- Trực quan hóa dữ liệu: Biểu đồ bong bóng thể loại sách (Category Bubble Chart) sử dụng D3.js.
- Bảng dữ liệu tương tác cao: Quản lý dạng bảng tính mạnh mẽ qua TanStack Table với tính năng lọc, tìm kiếm siêu tốc, phân trang và sắp xếp đa tiêu chí.
- Hoạt động ngoại tuyến 100% (Offline-First): Vào thẳng ứng dụng xem và chỉnh sửa dữ liệu tức thì không cần đăng nhập Google ngay khi khởi chạy. Mọi thay đổi khi offline được ghi nhận vào hàng đợi biến động (`book_mutation_queue`).
- Đồng bộ đám mây và chia sẻ gia đình qua Google Drive / Google Sheets: Không cần máy chủ backend trung gian (Zero-Server Architecture). Admin có thể tạo hoặc liên kết tệp Google Sheet trung tâm, mời các thành viên gia đình tham gia với các cấp độ quyền rõ ràng (`ADMIN`, `EDITOR`, `VIEWER`).

---

## 2. CÔNG NGHỆ VÀ MÔI TRƯỜNG CHẠY

- **Frontend Core**: React 19 (`19.0.1`), TypeScript 5.8 (`~5.8.2`), Vite 6 (`^6.2.3`).
- **Styling & UI**: Tailwind CSS 4 qua plugin Vite (`@tailwindcss/vite`), hệ thống biểu tượng Lucide React (`lucide-react`).
- **Nền tảng Di động (Android Native)**: Capacitor 6 (`@capacitor/core`, `@capacitor/android`, `@capacitor/app`, `@capacitor/filesystem`, `@capacitor/preferences`, `@capacitor/share`, `@capacitor/status-bar`, `@capacitor-community/file-opener`, `@codetrix-studio/capacitor-google-auth`).
- **Trí tuệ nhân tạo (AI Engine)**: Google Gen AI TypeScript SDK (`@google/genai`) phiên bản mới nhất, tối ưu cho các mô hình `gemini-3.8-flash` và `gemini-3.1-flash-lite`.
- **Thư viện xử lý dữ liệu & Bảng tính**:
  - `@tanstack/react-table` (v8.21.2) cho bảng dữ liệu sách.
  - `d3` (v7.9.0) cho biểu đồ bong bóng thể loại trực quan.
  - `xlsx` (v0.18.5) cho tính năng nhập/xuất tệp Excel và CSV.
  - `pdfjs-dist` (v6.3.289) & `jszip` (v3.10.2) hỗ trợ xử lý tài liệu.
- **Dịch vụ Đám mây & Đồng bộ**:
  - Google Drive REST API v3 và Google Sheets REST API v4 (gọi trực tiếp từ Client bằng Fetch API với phạm vi quyền hẹp `drive.file`).
  - Google Identity Services (GIS) trên Web và GoogleAuth native trên Android.
  - Firebase App/Auth hỗ trợ xác thực danh tính người dùng Google.
- **Lưu ý môi trường chạy**:
  - Hệ thống vận hành độc lập, không cần API server riêng.
  - Ứng dụng lưu trữ dữ liệu chính trong `localStorage` kết hợp Capacitor `Preferences` trên Android. Dự án không sử dụng Dexie/IndexedDB.
  - `npm run lint` chạy kiểm tra TypeScript (`tsc --noEmit`).

---

## 3. KIẾN TRÚC VÀ SƠ ĐỒ MÃ NGUỒN

### Điểm vào và Khởi tạo Ứng Dụng
- `index.html`: Khung trang HTML Vite, cấu hình viewport di động, chống phóng to sai lệch và hỗ trợ safe area.
- `src/main.tsx`: Khởi tạo React root, cấu hình ErrorBoundary và ToastProvider.
- `src/App.tsx`: Bộ điều phối trung tâm quản lý State cấp cao, điều hướng tab, tích hợp Auth, khởi chạy đồng bộ Drive nền, quản lý vòng đời ứng dụng và nạp các Modal.

### Giao diện và Component Tính Năng
- `src/components/Navbar.tsx`: Thanh điều hướng kép (Top Bar trên Desktop/Mobile và Bottom Navigation Dock trên di động), hiển thị huy hiệu số lượng sách, chỉ báo trạng thái đồng bộ (Online / Offline / Đang đồng bộ / Cảnh báo cần đăng nhập), menu người dùng và nút thao tác nhanh.
- `src/components/BookTableView.tsx`: Màn hình bảng sách trung tâm, hỗ trợ tìm kiếm mờ, lọc theo thể loại, phân trang, chế độ xem thẻ sách (Grid View) hoặc bảng (Table View).
- `src/components/CategoryBubbleChart.tsx`: Trực quan hóa tỷ trọng các thể loại sách bằng biểu đồ bong bóng tương tác D3.js.
- `src/components/BatchScanner.tsx`: Giao diện quét camera và tải ảnh hàng loạt, điều phối OCR AI và trích xuất sách.
- `src/components/ImageCropModal.tsx`: Hộp thoại cắt và xoay ảnh chụp gáy sách trước khi đưa vào mô hình AI nhận diện.
- `src/components/AddEditBookModal.tsx`: Hộp thoại thêm mới hoặc chỉnh sửa thông tin sách, tích hợp tìm kiếm nhanh từ Google Books API.
- `src/components/DataSyncModal.tsx`: Trung tâm điều khiển đồng bộ Google Drive, tạo mới file Sheet, chọn file có sẵn, nhập/xuất Excel/CSV và xóa liên kết.
- `src/components/FamilyShareModal.tsx`: Quản lý danh sách thành viên gia đình, phân quyền (`Owner`, `Editor`, `Viewer`) và đồng bộ quyền Drive ACL.
- `src/components/SettingsModal.tsx`: Cài đặt danh mục thể loại, cấu hình Gemini API Key tùy chỉnh, quản lý làm giàu dữ liệu tự động và sao lưu.
- `src/components/ModeSelectionModal.tsx`: Hộp thoại chuyển đổi giữa chế độ Ngoại Tuyến (Offline Local) và Trực Tuyến (Online Google Sync).
- `src/components/AppUpdateModal.tsx`: Hộp thoại thông báo và tải bản cập nhật APK mới nhất từ GitHub Releases.

### Tầng Dịch Vụ, Nghiệp Vụ và Lưu Trữ
- `src/types.ts`: Khai báo toàn bộ kiểu dữ liệu thực thể (`BookRecord`, `DraftBookItem`, `AuthUser`, `UserRole`, `LibrarySettings`, `BookMutation`...).
- `src/utils/localBooksStorage.ts`: Quản lý lưu trữ local (`local_books_cache_v2`), cài đặt (`library_settings_v2`), **Hàng đợi Mutation Ngoại Tuyến** (`book_mutation_queue_v1`), và **Cờ Bảo Vệ Phục Hồi Master** (`library_master_restore_required_v1`).
- `src/services/googleAuthService.ts`: Quản lý phiên đăng nhập Google đa tầng, Access Token in-memory, làm mới token ngầm (Silent Refresh) trên Android Native và Web GIS.
- `src/services/driveSyncService.ts`: Điều phối giao tiếp Google Drive API v3 và Sheets API v4, nhận diện tệp ngầm qua `appProperties`, hợp nhất 2 chiều, ghi tab `__CONFIG__` và đối chiếu quyền ACL.
- `src/services/geminiService.ts` & `src/utils/geminiService.ts`: Tích hợp Google GenAI SDK, chia nhỏ ảnh micro-batch, prompt OCR đa hướng và phân tích cấu trúc sách tiếng Việt.
- `src/services/bookLookupService.ts`: Tra cứu siêu dữ liệu sách từ Google Books và Open Library.
- `src/utils/cleanSlateService.ts`: Cơ chế chống khôi phục dữ liệu rác từ cơ chế Auto-Backup của hệ điều hành Android khi cài mới app.
- `src/utils/fuzzyMatcher.ts`: Thuật toán so khớp mờ tìm kiếm sách trùng lặp dựa trên Levenshtein distance và chuẩn hóa xâu tiếng Việt.

---

## 4. MÔ HÌNH NGHIỆP VỤ VÀ QUY TẮC DỮ LIỆU

### Thực thể Sách (`BookRecord`)
Mỗi bản ghi sách trong hệ thống được định nghĩa tinh gọn:
- `id`: Định danh duy nhất (UUID v4 hoặc chuỗi định danh dạng chuỗi số/timestamp).
- `title`: Tên sách (Bắt buộc).
- `author`: Tác giả (Bắt buộc, mặc định "Chưa rõ" nếu chưa xác định).
- `category`: Thể loại sách (Văn học Việt Nam, Lịch sử, Kinh tế, v.v., mặc định "Chung").
- `publisher`: Nhà xuất bản (Tùy chọn).
- `created_at`: Thời điểm tạo (Epoch milliseconds).
- `updated_at`: Thời điểm cập nhật cuối (Epoch milliseconds).
- `is_ai_normalized`: Cờ đánh dấu đã qua chuẩn hóa AI hoặc Google Books.

### Quy tắc Chuẩn Hóa & Lọc Trùng Lặp
1. **Làm sạch chuỗi tiếng Việt**: Tự động loại bỏ ký tự rác, chuẩn hóa khoảng trắng, viết hoa chữ cái đầu danh từ riêng.
2. **So khớp mờ (`fuzzyMatcher`)**:
   - Hai cuốn sách được xem là trùng lặp tiềm năng nếu tên sách có độ tương đồng $\ge 82\%$ và tác giả trùng khớp.
   - Khi phát hiện trùng lặp trong luồng quét AI, sách bị trùng được gắn cờ `isDuplicate` và hiển thị gợi ý cho người dùng quyết định giữ lại, gộp thông tin hoặc bỏ qua.
3. **Danh mục mặc định (`DEFAULT_CATEGORIES`)**:
   Hệ thống cung cấp sẵn 14 thể loại phổ biến trong gia đình Việt Nam. Người dùng có thể thêm/bớt danh mục tùy ý trong màn hình Cài đặt.

---

## 5. LƯU TRỮ VÀ ĐỒNG BỘ GOOGLE DRIVE

### 5.1 Lưu Trữ Tại Máy (Local-First Architecture)
- Dữ liệu sách được lưu dạng JSON trong `localStorage` tại khóa `local_books_cache_v2`.
- Cài đặt ứng dụng lưu tại khóa `library_settings_v2`.
- **Cơ chế CleanSlate (`cleanSlateService.ts`)**: Khi ứng dụng được cài đặt lần đầu trên Android, hệ điều hành Android có thể tự động khôi phục dữ liệu rác cũ từ Google Drive Device Backup. Cơ chế CleanSlate kiểm tra phiên bản tại `version.json`, nếu phát hiện cài mới sẽ dọn dẹp sạch sẽ kho sách, đảm bảo khởi đầu chuẩn xác 100%.

### 5.2 Hàng Đợi Biến Động Ngoại Tuyến (Offline Mutation Queue)
Học hỏi từ kiến trúc của dự án Sổ Tiết Kiệm, Kho Sách áp dụng cơ chế hàng đợi biến động:
- Khi thiết bị không có mạng hoặc chưa đăng nhập: Mọi thao tác Thêm (`CREATE`), Sửa (`UPDATE`), Xóa (`DELETE`) sách đều được ghi nhận vào `book_mutation_queue_v1`.
- Nhiều thao tác sửa đổi liên tiếp trên cùng một cuốn sách sẽ được tự động gộp (collapse) lại phiên bản mới nhất.
- Khi có mạng và kết nối Google Drive thành công: Hệ thống đọc snapshot mới nhất từ Google Sheet, phát lại (replay) các mutation trong queue lên dữ liệu đám mây, lưu tệp Sheet và chỉ xóa các mutation khỏi queue sau khi Google API xác nhận thành công.
- **Cờ Phục Hồi Master (`isMasterRestoreRequired`)**: Nếu người dùng xóa sạch dữ liệu trên máy local, hệ thống đánh dấu cờ `library_master_restore_required_v1`. Lần đồng bộ kế tiếp sẽ kéo toàn bộ dữ liệu từ Google Sheet về máy thay vì đẩy mảng rỗng lên xóa sạch kho sách trên đám mây.

### 5.3 Cấu Trúc Bảng Tính Google Sheet Trung Tâm
Mỗi tệp Google Sheet liên kết gồm có 2 tab:
1. **Tab `Khosach` (Sheet dữ liệu chính)**:
   - Dòng 1: Tiêu đề các cột tiếng Việt: `ID Sách`, `Tên sách`, `Tác giả`, `Thể loại`, `Nhà xuất bản`, `Ngày tạo`, `Cập nhật lần cuối`, `Chuẩn hóa AI`.
   - Từ dòng 2 trở đi: Dữ liệu từng cuốn sách. Cột A lưu ID duy nhất của sách để đối chiếu.
2. **Tab `__CONFIG__` (Sheet cấu hình ẩn)**:
   - Được thiết lập ẩn (`hidden: true`) để bảo vệ an toàn.
   - Lưu trữ metadata dưới dạng Key-Value:
     - `__METADATA_JSON__`: JSON chứa `schemaVersion`, `status` (`active` | `unlinked`), `adminEmail`, `activeFileName`, `updatedAt`.
     - `members`: Danh sách thành viên gia đình kèm vai trò (`Owner`, `Editor`, `Viewer`).
     - `custom settings`: Cấu hình danh mục và các cặp sách bỏ qua trùng lặp (`ignoredDuplicatePairs`).

### 5.4 Cơ Chế Nhận Diện Tự Động (Auto-Discovery qua `appProperties`)
- Tệp Google Sheet được gắn nhãn ngầm trên Google Drive API qua `appProperties`:
  ```json
  {
    "appProperties": {
      "app": "khosach_app",
      "khosach_app_id": "com.khosach.app",
      "workspace_type": "family_library",
      "status": "active"
    }
  }
  ```
- Khi thành viên đăng nhập, ứng dụng truy vấn Drive API với đúng 1 request:
  `q = appProperties has { key='khosach_app_id' and value='com.khosach.app' } and trashed = false`
- Ứng dụng đọc tab `__CONFIG__` của tệp, đối chiếu email của người dùng với danh sách thành viên để tự động kết nối và gán quyền tương ứng (`ADMIN`, `EDITOR`, `VIEWER`) mà không cần người dùng phải copy/paste link thủ công.

---

## 6. ĐĂNG NHẬP, VAI TRÒ VÀ BẢO MẬT

### 6.1 Cơ Chế Quản Lý & Refresh Token Đa Tầng (Multi-tier Token)
- **Tầng 1 (In-Memory RAM)**: Biến `cachedAccessToken` lưu token đang chạy để các hàm API gọi tức thì với độ trễ 0ms. Token trong RAM tự động biến mất khi đóng tab trên trình duyệt.
- **Tầng 2 (Persistent Native Preferences / LocalStorage)**: Lưu token và thời điểm hết hạn (`expiresAt`) an toàn. Trên Android Native, sử dụng Capacitor Preferences.
- **Tầng 3 (Token Validity & Silent Refresh Background)**:
  - Hàm `isGoogleTokenValid()` kiểm tra tính hợp lệ với biên độ an toàn trừ hao 60 giây trước khi token thực sự hết hạn.
  - Trên Android: Tự động gọi `GoogleAuth.refresh()` trong nền khi ứng dụng resume hoặc trước khi gọi Drive API mà không bật bất kỳ popup nào.
  - Trên Web: Tự động thử làm mới ngầm qua Google Identity Services Token Client (`prompt: 'none'`). Nếu không thể làm mới ngầm, hiển thị cảnh báo mềm trên giao diện (chấm vàng, nút "Đồng bộ ngay!") để người dùng chủ động bấm kết nối lại mà không chặn màn hình đọc sách.

### 6.2 Phân Quyền Gia Đình (Role-Based Access Control)
- `ADMIN` (`Owner`): Toàn quyền thêm, sửa, xóa sách; tạo mới bảng tính, mời/xóa thành viên gia đình, đổi quyền thành viên, hủy liên kết Workspace.
- `EDITOR`: Thêm mới, chỉnh sửa, xóa sách và đồng bộ lên Google Sheet chung. Không có quyền sửa đổi cấu hình thành viên hay hủy liên kết bảng tính.
- `VIEWER`: Chỉ xem danh mục sách gia đình và tìm kiếm; không được phép thêm, sửa, xóa sách trên bảng tính chung. Khi đồng bộ, dữ liệu từ Google Sheet luôn ghi đè cục bộ xuống máy của Viewer.

### 6.3 Bảo Mật Khóa API Gemini
- Gemini API Key không bao giờ được lưu cứng vào mã nguồn.
- Người dùng có thể nhập API Key cá nhân trong Cài Đặt (lưu cục bộ tại thiết bị trong `localStorage`) hoặc hệ thống sử dụng khóa môi trường do quản trị viên cấp phát.

---

## 7. CÁC LUỒNG NGƯỜI DÙNG CHÍNH

### Luồng 1: Khởi Động & Truy Cập Ngoại Tuyến (Zero-Friction Offline Start)
1. Ứng dụng mở ra, chạy kiểm tra CleanSlate, nạp dữ liệu sách từ `localStorage`.
2. Vào **THẲNG** giao diện Bảng sách (`BookTableView`). Hoàn toàn không hiển thị popup chặn hay ép buộc đăng nhập.
3. Người dùng offline có thể tra cứu, thêm sách mới, sửa sách, xóa sách và xem biểu đồ thể loại bình thường.
4. Mọi thay đổi cục bộ được ghi vào `book_mutation_queue`.

### Luồng 2: Quét Sách Bằng AI (Batch Scanner Flow)
1. Người dùng chọn tab "Quét AI", chụp ảnh từ camera hoặc chọn nhiều ảnh từ thư viện.
2. Với từng ảnh, có thể mở công cụ cắt ảnh (`ImageCropModal`) để chỉnh vùng gáy sách.
3. Mô hình Gemini Flash phân tích ảnh, trích xuất danh sách sách dự kiến (Tên, Tác giả, NXB, Thể loại).
4. Hệ thống kiểm tra trùng lặp qua `fuzzyMatcher`.
5. Người dùng xem trước bảng nháp, bấm "Lưu vào kho sách".

### Luồng 3: Kết Nối Google Drive & Tự Động Nhận Diện Tệp
1. Người dùng bấm "Đăng nhập" trên Navbar hoặc chọn "Đồng bộ Google Drive" trong Cài đặt.
2. Đăng nhập thành công, hệ thống tự động quét tìm tệp Google Sheet có gắn nhãn `khosach_app_id`.
3. Nếu tìm thấy tệp mà tài khoản là Admin hoặc Thành viên: Tự động liên kết, gán vai trò (`ADMIN`/`EDITOR`/`VIEWER`), tự động chạy đồng bộ 2 chiều và hiển thị thông báo thành công.
4. Nếu chưa có tệp: Admin có thể bấm "Tạo mới kho sách" để khởi tạo bảng tính chuẩn 2 tab.

### Luồng 4: Đồng Bộ 2 Chiều & Giải Quyết Xung Đột
1. Người dùng bấm nút đồng bộ hoặc hệ thống tự động đồng bộ khi online.
2. Kéo dữ liệu mới nhất từ Sheet `Khosach`.
3. Replay các biến động từ hàng đợi `book_mutation_queue`.
4. Hợp nhất các bản ghi dựa trên thời điểm `updated_at`.
5. Ghi dữ liệu đã hợp nhất lên Google Sheet và dọn dẹp hàng đợi.

---

## 8. PHÁT TRIỂN, KIỂM THỬ VÀ PHÁT HÀNH

### Các lệnh trong `package.json`
- `npm run dev`: Chạy máy chủ phát triển Vite trên cổng 3000.
- `npm run lint`: Kiểm tra lỗi kiểu dữ liệu TypeScript (`tsc --noEmit`).
- `npm run build`: Biên dịch toàn bộ mã nguồn web vào thư mục `dist/`.
- `npm run build:apk`: Kiểm tra cấu hình `buildAab: false`, biên dịch web, đồng bộ Capacitor và đóng gói file APK Release (`./gradlew assembleRelease`).
- `npm run build:aab`: Kiểm tra cấu hình `buildAab: true`, biên dịch web, đồng bộ Capacitor và đóng gói file Android App Bundle (`./gradlew bundleRelease`).

### Đóng Gói và Phát Hành Android
1. File cấu hình Capacitor: `capacitor.config.ts` (App ID: `com.khosach.app` theo đúng cấu hình chính thức, cấu hình Google Auth Client ID).
2. Quy trình CI/CD GitHub Actions: Tự động kích hoạt khi push vào nhánh `main`. Quy trình đọc trường `buildAab` trong `package.json` để quyết định phát hành APK lên GitHub Releases hay xuất AAB artifact.

---

## 9. HẠN CHẾ ĐÃ BIẾT & CẦN KIỂM TRA TRƯỚC KHI SỬA

1. **Giới hạn dung lượng `localStorage`**: Không lưu ảnh bìa định dạng Base64 kích thước lớn vào `BookRecord` để tránh vượt quá hạn mức 5MB của trình duyệt. Chỉ lưu URL hoặc đường dẫn ảnh.
2. **Kích thước file lớn**: `src/App.tsx` và `src/services/driveSyncService.ts` chứa nhiều logic điều phối cấp cao. Khi tái cấu trúc, cần kiểm tra kỹ lưỡng các vị trí gọi hàm liên quan để tránh đứt gãy luồng state.
3. **Phân biệt phạm vi quyền Google API**: Quyền Google Drive (`drive.file`) cho phép ứng dụng đọc/ghi các file do chính ứng dụng tạo ra hoặc được người dùng mở qua Google Picker. Nếu một thành viên mở file không do app tạo mà không qua phân quyền hợp lệ, Sheets API có thể trả về lỗi 403/404.
4. **Không có giao dịch nguyên tử (Atomic Transactions) trên Sheets**: Google Sheets API không hỗ trợ transaction cấp cơ sở dữ liệu. Cơ chế kiểm tra lạc quan và hàng đợi mutation được thiết kế để giảm thiểu tối đa xung đột khi nhiều người cùng thao tác.

---

## 10. DANH SÁCH KIỂM TRA AN TOÀN KHI TIẾP NHẬN

Khi nhận bàn giao hoặc thực hiện chỉnh sửa mã nguồn, kỹ sư/agent cần tuân thủ nghiêm ngặt 7 bước sau:

1. **Kiểm tra trạng thái mã nguồn**: Chạy `git status` và `git diff` để đảm bảo không ghi đè lên các thay đổi đang có sẵn.
2. **Bảo toàn thông tin xác thực**: Tuyệt đối không xóa, không làm lộ hoặc làm hỏng cấu hình Firebase (`firebase-applet-config.json`), Google Services (`google-services.json`) và Google Client ID.
3. **Kiểm tra tính nhất quán của mô hình dữ liệu**: Nếu thay đổi trường của `BookRecord`, phải cập nhật đồng thời trong `src/types.ts`, `src/utils/localBooksStorage.ts`, hàm mapping trong `src/services/driveSyncService.ts` và tiêu đề cột trong Google Sheet.
4. **Kiểm tra luồng Offline-first**: Đảm bảo ứng dụng luôn mở được và hiển thị danh mục sách bình thường khi tắt hoàn toàn kết nối mạng (Airplane mode / Offline).
5. **Kiểm tra luồng Token & Refresh**: Kiểm tra khi token hết hạn, ứng dụng không bị văng, không hiện popup chặn và có thể tự động refresh ngầm trên Android.
6. **Kiểm tra biên dịch**: Chạy `npm run lint` và `npm run build` để đảm bảo TypeScript không có bất kỳ cảnh báo hoặc lỗi cú pháp nào.
7. **Kiểm tra đóng gói**: Nếu thay đổi liên quan đến cấu hình native, kiểm tra tính tương thích giữa `package.json` (`buildAab`), `capacitor.config.ts` và Gradle scripts.

---

## 11. PHÂN TÍCH CHUYÊN SÂU: CÁC BÀI HỌC ÁP DỤNG TỪ DỰ ÁN SỔ TIẾT KIỆM

Dự án "Kho Sách" đã học hỏi và tích hợp thành công các tinh hoa kiến trúc từ dự án "Sổ Tiết Kiệm":

1. **Khả năng truy cập tức thì (Zero-Barrier Offline Access)**:
   - *Từ Sổ Tiết Kiệm*: Người dùng mở app là vào thẳng bảng số liệu, không bị chặn bởi bất kỳ modal chọn chế độ hay yêu cầu đăng nhập nào.
   - *Áp dụng vào Kho Sách*: Đã loại bỏ hoàn toàn việc ép mở `ModeSelectionModal` khi khởi chạy hoặc khi mất phiên đăng nhập. Người dùng sử dụng 100% tính năng local ngay lập tức.

2. **Quản lý Token Đa Tầng (Multi-tier Token Management)**:
   - *Từ Sổ Tiết Kiệm*: In-memory access token trên Web, Capacitor Preferences trên Android, kiểm tra thời hạn an toàn 60 giây và silent refresh ngầm qua `GoogleAuth.refresh()`.
   - *Áp dụng vào Kho Sách*: Đã chuẩn hóa toàn bộ luồng lưu trữ và refresh token trong `googleAuthService.ts`, tách biệt hoàn toàn phiên đăng nhập Firebase với Access Token Google Drive.

3. **Hàng Đợi Biến Động Ngoại Tuyến (Offline Mutation Queue)**:
   - *Từ Sổ Tiết Kiệm*: Cơ chế Offline Sync 1.0.1 với hàng đợi mutation (tạo, sửa, xóa) thay vì ghi đè toàn bộ mảng dữ liệu.
   - *Áp dụng vào Kho Sách*: Triển khai `book_mutation_queue_v1` trong `localBooksStorage.ts` và thuật toán replay mutation trong `driveSyncService.ts`.

4. **Cờ Bảo Vệ Khôi Phục Master (`master_restore_required`)**:
   - *Từ Sổ Tiết Kiệm*: Ngăn chặn việc người dùng vô tình bấm "Xóa sạch dữ liệu trên máy" rồi đồng bộ làm mất toàn bộ dữ liệu trên bảng tính chung của gia đình.
   - *Áp dụng vào Kho Sách*: Khi xóa sạch sách ở local, hệ thống bật cờ bảo vệ để lần đồng bộ sau sẽ kéo dữ liệu từ Master Sheet về thay vì xóa trắng đám mây.

5. **Nhận Diện Workspace Tự Động qua `appProperties`**:
   - *Từ Sổ Tiết Kiệm*: Quét 1 query duy nhất qua thuộc tính ẩn `appProperties` và đọc tab `__CONFIG__` để tự động gán vai trò (`ADMIN`, `EDITOR`, `VIEWER`).
   - *Áp dụng vào Kho Sách*: Chuẩn hóa nhãn `khosach_app_id: com.khosach.app` và quy trình đọc cấu hình từ tab `__CONFIG__`.

---
*Tài liệu được biên soạn và chuẩn hóa theo tiêu chuẩn chuyển giao kỹ thuật của hệ sinh thái ứng dụng gia đình.*
