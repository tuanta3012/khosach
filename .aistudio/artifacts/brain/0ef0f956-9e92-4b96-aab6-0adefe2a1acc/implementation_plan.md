# Hệ Thống Trích Xuất Quy Tắc Tự Động Chạy Ngầm (Zero-UI / Headless Background Architecture)

Hệ thống tự động học và trích xuất quy tắc chạy ngầm 100% dưới tầng logic (service/background), **hoàn toàn không phát sinh thêm bất kỳ giao diện, modal, tab cài đặt hay nút bấm nào**. Hệ thống tự động móc nối (hook) trực tiếp vào các sự kiện duyệt sẵn có, lưu kép tức thì vào `localStorage` và tab `__CONFIG__` của Google Sheet, nạp tức thì cho các lượt AI kế tiếp (kể cả khi tạm dừng rồi chạy tiếp), chỉ gửi đóng góp lên Cloud Firestore khi hoàn tất toàn bộ quy trình, và chỉ kiểm tra Cloud 1 lần duy nhất khi mở app.

### User Review & Critical Decisions

> [!IMPORTANT]
> **Cam kết thiết kế Zero-UI (100% Headless & Background):**
> 1. **Không thêm giao diện**: Giữ nguyên vẹn 100% giao diện người dùng hiện tại của app Kho Sách. Không thêm màn hình quản lý quy tắc, không thêm nút bấm hay thanh điều khiển mới.
> 2. **Tự động kích hoạt theo sự kiện có sẵn**:
>    - Khi người dùng bấm **"Áp dụng"** trong bảng duyệt AI có sẵn ➔ Logic ngầm tự động phân tích và sinh quy tắc.
>    - Khi người dùng bấm **"Xác nhận giữ sách"** trong bảng duyệt trùng lặp có sẵn ➔ Logic ngầm tự động sinh quy tắc phân biệt tập.
> 3. **Lưu kép tức thì**: Tự động lưu vào `localStorage` và đồng bộ ngầm lên tab `__CONFIG__` của Google Sheet.
> 4. **Áp dụng tức thì cho lượt chạy tiếp**: Nếu người dùng tạm dừng duyệt rồi bấm chạy tiếp, mẻ sách tiếp theo tự động hưởng ngay các quy tắc mới.
> 5. **Đóng góp Cloud Firestore khi kết thúc quy trình**: Khi xử lý xong toàn bộ danh sách, 1 request duy nhất được gửi ngầm lên Cloud.
> 6. **Khởi động app chỉ check Cloud 1 lần**: Khi mở app, 1 lời gọi ngầm kiểm tra bảng quy tắc cộng đồng và kết thúc, không lặp lại trong phiên.

- **Quyết định 1 (Đã xác nhận)**: Zero-UI — Hoàn toàn chạy ngầm dưới service logic, không thêm bất kỳ thành phần giao diện nào.
- **Quyết định 2 (Đã xác nhận)**: Móc nối tự động vào các hàm xử lý sẵn có (`handleApplyApprovedProposals`, `handleConfirmKeepDuplicates`, `handleStartNormalize`).
- **Quyết định 3 (Đã xác nhận)**: Lưu tức thì LocalStorage + Sheet Config, áp dụng ngay khi chạy tiếp sau tạm dừng.
- **Quyết định 4 (Đã xác nhận)**: Gửi Cloud Firestore ở cuối quy trình; mở app check Cloud 1 lần duy nhất.

---

### 1. Overview & Core Concept

- **Nguyên lý hoạt động tĩnh lặng (Silent Operation)**:
  - Người dùng sử dụng app như bình thường: nhập sách, quét trùng, hiệu chỉnh AI, tạm dừng xem xét, bấm áp dụng.
  - Bên dưới hậu trường (behind the scenes), một bộ suy diễn quy tắc (Rule Inference Engine) tự động quan sát các quyết định này:
    - *Người dùng đã sửa gì?* (Xóa tiền tố "BS.", sửa tên tập, chuẩn hóa viết hoa, giữ phụ đề, gán thể loại).
    - *Người dùng đã bác bỏ gì?* (Giữ nguyên tên gốc, không cho AI đổi lung tung).
    - *Người dùng đã phân biệt cặp sách nào?* (Hai cuốn cùng tên nhưng khác số tập).
  - Ngay lập tức, bộ quy tắc cá nhân được cập nhật và có hiệu lực ngay trong phiên chạy đó mà người dùng không cần phải thiết lập hay cấu hình bất kỳ thứ gì.

---

### 2. User Experience & Visual Design

- **Giao diện người dùng**: Giữ nguyên vẹn giao diện hiện có, tuân thủ nghiêm ngặt **Hiến pháp Thiết kế Frontend** (Zero-Pill, không phát sinh phần tử thừa, không phá vỡ bố cục).
- **Phản hồi thông báo (Toasts)**: Sử dụng hệ thống Toast Context sẵn có, thông báo ngắn gọn khi lưu dữ liệu như bình thường (không làm phiền người dùng bằng các thông số kỹ thuật phức tạp).

---

### 3. Key Product Decisions & Trade-Offs

#### Quyết định 1: Kiến trúc Headless thuần túy (Pure Service-Layer Architecture)
- **Cách tiếp cận**: Tập trung toàn bộ logic vào `src/services/curationLearningService.ts` và tích hợp kín vào:
  - `src/components/SettingsModal.tsx`: Tự động gọi trích xuất quy tắc khi người dùng bấm Áp dụng hoặc Xác nhận giữ sách.
  - `src/utils/geminiService.ts`: Tự động nạp quy tắc vào System Instruction và Few-Shot Prompt của Gemini.
  - `src/utils/fuzzyMatcher.ts`: Tự động kiểm tra quy tắc phân biệt tập trước khi báo trùng lặp.
  - `src/services/driveSyncService.ts`: Tự động đồng bộ quy tắc vào tab `__CONFIG__`.
  - `src/App.tsx`: Kích hoạt kiểm tra Cloud 1 lần duy nhất khi ứng dụng khởi động.
- **Lý do**: Đảm bảo app luôn gọn gàng, trực quan và dễ sử dụng nhất cho người dùng phổ thông và gia đình.

#### Quyết định 2: Bảng Quy Tắc Tinh Gọn Trên Cloud Firestore
- **Cách tiếp cận**: Collection `/community_consensus_rules/` trên Firestore chỉ lưu các quy tắc dạng cấu trúc JSON nhỏ gọn (kích thước tổng toàn bộ bảng quy tắc $\le 20\text{ KB}$).
- **Không lưu dữ liệu thô**: Cloud hoàn toàn không lưu tên sách cá nhân hay nhật ký thao tác thô của người dùng. Chỉ lưu các mẫu quy tắc đã được biểu quyết cao nhất.

---

### 4. Technical Architecture & Data Strategy

#### Sơ đồ Kiến trúc Chạy Ngầm (Headless Dataflow)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          GIAO DIỆN HIỆN CÓ (GIỮ NGUYÊN)                      │
│                                                                             │
│   [Nút "Áp dụng" / "Xác nhận giữ sách" sẵn có trong SettingsModal]          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (Móc nối ngầm tự động)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 src/services/curationLearningService.ts                     │
│                                                                             │
│   1. synthesizeRulesFromReview(proposals) / synthesizeFromDuplicates()      │
│      • So sánh chuỗi gốc & chuỗi duyệt ➔ Sinh ra quy tắc regex/pattern      │
│                                                                             │
│   2. Lưu tức thì kép (Dual-Save in < 10ms):                                 │
│      ├── localStorage: 'library_learned_rules_v1'                           │
│      └── Google Sheet Config: saveLearnedRulesToSheetConfig()               │
│                                                                             │
│   3. Nạp quy tắc vào bộ nhớ phiên (In-Memory Hot Reload):                   │
│      • Khi bấm chạy tiếp ➔ Gemini Service đọc ngay quy tắc mới              │
│                                                                             │
│   4. flushSessionToCloud():                                                 │
│      • Chỉ gọi 1 lần khi kết thúc toàn bộ danh sách ➔ Gửi lên Firestore     │
│                                                                             │
│   5. checkStartupCloudRulesOnce():                                          │
│      • Chỉ gọi đúng 1 lần khi mở app ➔ Tải bảng quy tắc cộng đồng           │
└──────────────┬───────────────────────┬──────────────────────┬───────────────┘
               │                       │                      │
               ▼                       ▼                      ▼
    ┌────────────────────┐   ┌──────────────────┐   ┌───────────────────┐
    │    LocalStorage    │   │ Google Sheet     │   │ Cloud Firestore   │
    │  (Bộ nhớ tức thì)  │   │ (Tab __CONFIG__) │   │ (Quy tắc chung)   │
    └────────────────────┘   └──────────────────┘   └───────────────────┘
```

#### Cấu trúc Dữ liệu Quy Tắc Ngầm (TypeScript)

```typescript
export interface LearnedRule {
  id: string; // VD: "rule_author_prefix_bs"
  type: 'VOLUME_DISAMBIGUATION' | 'AUTHOR_PREFIX_STRIP' | 'SUBTITLE_PRESERVE' | 'CATEGORY_KEYWORD_MAP';
  pattern: string;
  action: 'STRIP' | 'REPLACE' | 'MARK_DISTINCT' | 'SET_CATEGORY';
  value?: string;
  source: 'USER_LOCAL' | 'COMMUNITY';
  votes: number;
  createdAt: number;
}
```

#### Các điểm móc nối ngầm cụ thể trong mã nguồn:
1. **Trong `SettingsModal.tsx`**:
   - Tại `handleApplyApprovedProposals`: Ngay sau khi duyệt xong, gọi ngầm `recordApprovedProposals(selectedOnes)`. Quy tắc sinh ra được lưu vào LocalStorage và gửi ngầm lên Google Sheet `__CONFIG__`.
   - Tại `handleConfirmKeepDuplicates`: Ngay khi giữ từ 2 cuốn trùng trở lên, gọi ngầm `recordDistinctPairs(keptBooks)`.
   - Tại `handleStartNormalize`: Đọc danh sách quy tắc nóng từ `curationLearningService.getActiveRules()` để nạp vào `batchNormalize`.
   - Khi chạy xong mẻ cuối cùng (hoặc dừng hẳn): gọi ngầm `curationLearningService.flushContributionsToCloud()`.
2. **Trong `src/utils/geminiService.ts`**:
   - Trong `batchNormalize`: Tự động tiêm các quy tắc đang hoạt động vào System Instruction của Gemini dưới dạng nguyên tắc chuẩn hóa bắt buộc.
3. **Trong `src/App.tsx`**:
   - `useEffect` khởi động ứng dụng: Gọi ngầm `curationLearningService.syncStartupCloudRulesOnce()`. Cờ `hasCheckedCloudRulesThisSession` đảm bảo chỉ chạy 1 lần duy nhất trong toàn bộ vòng đời phiên làm việc.

---

### 5. Kế hoạch Kiểm tra & Triển khai

1. **Module `curationLearningService.ts`**:
   - Xây dựng các hàm trích xuất quy tắc tự động bằng regex/so sánh chuỗi.
   - Xây dựng bộ nhớ đệm LocalStorage và cơ chế lưu vào tab `__CONFIG__`.
   - Xây dựng hàm đọc/ghi Firestore siêu nhẹ (< 20 KB).
2. **Móc nối ngầm vào `SettingsModal.tsx`**:
   - Đảm bảo khi người dùng duyệt, quy tắc được sinh và lưu tức thì mà không hề làm đổi giao diện hay phát sinh độ trễ.
3. **Kiểm tra luồng Tạm dừng -> Chạy tiếp**:
   - Kiểm tra thực tế: Chạy chuẩn hóa ➔ Tạm dừng ở cuốn số 10 ➔ Duyệt ➔ Bấm chạy tiếp ➔ Xác nhận cuốn số 11 trở đi tự động áp dụng quy tắc vừa duyệt.
4. **Kiểm tra kết thúc quy trình**:
   - Xác nhận request lên Cloud Firestore chỉ phát sinh 1 lần khi mẻ cuối cùng hoàn tất.
5. **Kiểm tra khởi động app**:
   - Xác nhận app chỉ kiểm tra Firestore đúng 1 lần khi mở.
6. **Kiểm tra Build APK**:
   - Chạy `npm run lint` và `npm run build` xác nhận tương thích hoàn toàn cho Android APK/AAB.
