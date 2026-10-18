# Tối Ưu Cơ Chế Offline-First & Đồng Bộ Google Theo Mô Hình Sổ Tiết Kiệm

Tối ưu hóa toàn diện cơ chế Offline-First của Kho Sách: tối ưu hóa và chống tràn LocalStorage, loại bỏ hoàn toàn chế độ "user offline cũ" gò bó, và tích hợp khối khuyến nghị đăng nhập Google trực quan ngay trong popup đồng bộ và cài đặt (tương tự trải nghiệm ứng dụng Sổ Tiết Kiệm).

### User Review & Critical Decisions

> [!IMPORTANT]
> **Điểm mấu chốt được xác nhận từ yêu cầu:**
> 1. **Giữ LocalStorage nhưng tối ưu hóa sâu**: Không chuyển sang IndexedDB theo đúng mong muốn của bạn; thay vào đó, tối ưu serialization, chống tràn hạn ngạch (`QuotaExceededError`), dọn dẹp hàng đợi mutation sau đồng bộ và gỡ bỏ các trường dữ liệu rác.
> 2. **Loại bỏ chế độ User Offline cũ**: Không bắt người dùng phải "vào Cấu hình để bật Trực tuyến" như cảnh báo hiện tại trong ảnh. Ứng dụng luôn mặc định hoạt động trơn tru ngoại tuyến và tự động sẵn sàng kết nối đám mây bất kỳ lúc nào.
> 3. **Thêm Khuyến nghị Đăng nhập Google (Login Recommendation Card)**: Khi người dùng mở modal đồng bộ hoặc cài đặt lúc chưa đăng nhập, hiển thị thẻ khuyến nghị nổi bật, giải thích lợi ích bảo vệ dữ liệu kèm nút **"Đăng nhập bằng Google"** kích hoạt ngay lập tức.

---

### 1. Overview & Core Concept

- **Mục tiêu**: Người dùng luôn có trải nghiệm 0-giây khi mở ứng dụng trên điện thoại (đọc/ghi từ LocalStorage nhanh nhất). Đồng thời, việc kết nối đám mây Google Drive diễn ra tự nhiên, không rào cản, có khuyến nghị rõ ràng để tránh mất mát dữ liệu khi đổi thiết bị.
- **Đối tượng**: Người dùng cá nhân và gia đình sử dụng trên điện thoại (PWA/APK qua Capacitor), thường xuyên ở nơi mạng chập chờn hoặc không có mạng nhưng muốn dữ liệu được bảo vệ an toàn.
- **Giá trị cốt lõi**:
  - Không bao giờ bị chặn bởi thông báo "Bạn đang ở chế độ ngoại tuyến hãy bật trực tuyến trong cấu hình".
  - Một chạm đăng nhập Google Drive ngay tại màn hình đồng bộ.
  - Bộ nhớ LocalStorage được bảo vệ, tự dọn dẹp rác, bền bỉ và không bao giờ bị sập bộ nhớ.

---

### 2. User Experience & Visual Design

#### Luồng trải nghiệm người dùng (User Flows)
1. **Khi chưa đăng nhập Google (Local Guest / Offline-First)**:
   - Mở ứng dụng: Toàn bộ danh mục sách, thống kê, tìm kiếm hiển thị tức thì từ LocalStorage.
   - Bấm nút **Đồng bộ Google Drive** trên thanh điều hướng hoặc menu:
     - Không còn hộp thoại vàng cảnh báo cụt ngủn như ảnh chụp màn hình.
     - Thay vào đó là **Khối Khuyến Nghị Đăng Nhập (Google Cloud Backup Card)**:
       - Huy hiệu: `Khuyên dùng • Bảo vệ dữ liệu`
       - Tiêu đề: `Đăng nhập Google để sao lưu & đồng bộ`
       - Nội dung: `Sao lưu tự động lên Google Drive giúp bạn không bị mất kho sách khi đổi điện thoại, xóa dữ liệu hoặc cài lại ứng dụng.`
       - Nút CTA chính: **"Đăng nhập với Google"** (kèm icon Google nhiều màu chính hãng).
       - Các tính năng ngoại tuyến phụ vẫn khả dụng bên dưới: Nhập từ file Excel/CSV, Xuất file Excel.
   - Bấm "Đăng nhập với Google": Mở trực tiếp luồng đăng nhập Google qua Capacitor Google Auth hoặc Web Popup. Đăng nhập xong lập tức chuyển sang giao diện quản lý Google Sheet.

2. **Khi đã đăng nhập Google (Connected & Syncing)**:
   - Hiển thị tài khoản Google (avatar, tên, email) và tệp Sheet đang liên kết.
   - Tự động xả hàng đợi biến động ngoại tuyến (`Pending Mutation Queue`) lên Google Drive ngầm.
   - Trạng thái phản hồi tinh tế: icon xoay nhẹ nhàng khi đồng bộ, chuyển sang tick xanh ngọc khi hoàn tất.

#### Visual Hierarchy & Styling (Phong cách hiện đại, thanh thoát)
- **Thẻ khuyến nghị Google**: Nền gradient trắng ngà - xanh biển nhạt (`bg-gradient-to-br from-sky-50/80 via-white to-amber-50/40`), viền `border-sky-200/80`, góc bo `rounded-2xl`, bóng đổ `shadow-2xs`.
- **Nút CTA Google**: Nền trắng nổi bật trên nền xám nhẹ, viền `border-slate-200`, chữ `text-slate-800 font-bold`, hiệu ứng nhấn `active:scale-[0.98]`.
- **Huy hiệu trạng thái**: Loại bỏ chữ "OFFLINE" màu vàng dễ gây hiểu lầm là app bị lỗi; thay bằng nhãn `Lưu trên máy` hoặc `Đã bảo vệ đám mây`.

---

### 3. Key Product Decisions & Trade-Offs

- **Quyết định 1: Tối ưu LocalStorage thay vì di chuyển sang cơ sở dữ liệu khác**:
  - *Lý do*: Theo đúng chỉ định của người dùng. LocalStorage cho tốc độ đọc/ghi đồng bộ tức thì, không phát sinh chi phí asynchronous overhead, tương thích 100% Android WebView của Capacitor.
  - *Giải pháp tối ưu*:
    - Bọc cơ chế safe-write có bắt `QuotaExceededError`.
    - Dọn dẹp cache không cần thiết (các bản nháp scan cũ, hình ảnh base64 tạm thời).
    - Chuẩn hóa schema các cuốn sách, loại bỏ các thuộc tính undefined/null trước khi JSON stringify.
- **Quyết định 2: Hủy bỏ ranh giới giả tạo giữa "Chế độ Ngoại tuyến" và "Chế độ Trực tuyến"**:
  - *Hiện tại*: Ứng dụng bắt người dùng chọn 1 trong 2 chế độ từ đầu hoặc bắt vào Cài đặt để bật gạt công tắc.
  - *Mô hình Sổ Tiết Kiệm*: App luôn chạy Local-First. Trực tuyến chỉ là một tầng dịch vụ cộng thêm (Sync Layer). Nếu chưa đăng nhập, mời đăng nhập bằng nút bấm trực tiếp. Nếu đã đăng nhập, tự động đồng bộ khi có mạng.
- **Quyết định 3: Rà soát và loại bỏ `isOffline` cũ trong `AuthUser`**:
  - Loại bỏ hoàn toàn trường thừa `isOffline?: boolean` trong types và services; trạng thái người dùng chỉ đơn giản là `currentUser !== null` (đã đăng nhập) hoặc `currentUser === null` (chưa đăng nhập/khách).

---

### 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                 Giao diện Người dùng (React UI)             │
│   ┌───────────────────────┐     ┌───────────────────────┐   │
│   │ DataSyncModal.tsx     │     │ SettingsModal.tsx     │   │
│   │ [Thẻ Khuyến nghị Login]│     │ [Google Account Card] │   │
│   │ [Nút Đăng nhập Google]│     │ [Xóa/Dọn dẹp Storage] │   │
│   └───────────┬───────────┘     └───────────┬───────────┘   │
└───────────────┼─────────────────────────────┼───────────────┘
                │                             │
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│             Tầng Quản lý Đồng bộ & Xác thực (Services)      │
│   - googleAuthService.ts: Đăng nhập Google 1-chạm           │
│   - driveSyncService.ts: Đồng bộ 2 chiều Sheets             │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│             Tầng Lưu Trữ Tối Ưu (localBooksStorage.ts)       │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  • safeSaveLocalBooks: Try/Catch QuotaExceededError │   │
│   │  • Prune redundant fields & sanitize book objects    │   │
│   │  • Auto-drain mutation queue on sync success        │   │
│   │  • LocalStorage: local_books_cache_v2               │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### Các thành phần chính sẽ được cập nhật:
1. `src/utils/localBooksStorage.ts`:
   - Bổ sung hàm `safeSaveLocalBooks` chống crash khi đầy dung lượng.
   - Tối ưu cấu trúc bản ghi sách trước khi lưu.
   - Thêm tiện ích xóa dọn dẹp mutation queue rác.
2. `src/components/DataSyncModal.tsx`:
   - Thay thế toàn bộ khối cảnh báo vàng ở dòng 901-906 bằng Thẻ Khuyến nghị Đăng nhập Google chuẩn mô hình Sổ Tiết Kiệm.
   - Thêm nút Đăng nhập Google trực tiếp nhận hàm `onGoogleSignIn`.
   - Cập nhật header modal: thay huy hiệu "OFFLINE" bằng huy hiệu thân thiện hơn.
3. `src/App.tsx`:
   - Kết nối prop `onGoogleSignIn` trực tiếp vào `DataSyncModal`.
   - Loại bỏ các logic ép chuyển đổi "offline mode" cồng kềnh, đưa app về chế độ Local-First tự nhiên.
4. `src/types.ts` & `src/services/googleAuthService.ts`:
   - Loại bỏ thuộc tính dư thừa `isOffline` trong `AuthUser`.
