import { BookRecord } from '../types';
import {
  normalizeForComparison,
  removeVietnameseTones,
  stringSimilarity,
  levenshteinDistance,
} from './fuzzyMatcher';

/**
 * Chuẩn hóa tên thể loại mới do người dùng nhập:
 * - Gọt khoảng trắng thừa
 * - Viết hoa chữ cái đầu nếu toàn bộ đều viết thường
 */
export function formatCustomCategoryName(raw: string): string {
  const cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Chung';
  // Nếu chữ cái đầu đang viết thường, tự động viết hoa chữ cái đầu cho đẹp
  return cleaned.charAt(0).toLocaleUpperCase('vi-VN') + cleaned.slice(1);
}

/**
 * Bảng từ đồng nghĩa / tên rút gọn phổ biến cho các thể loại chuẩn
 * Giúp nhận diện khi người dùng gõ cách gọi khác nhưng thực chất trùng thể loại đã có.
 */
const CATEGORY_ALIAS_GROUPS: Array<{ canonicalNorm: string; aliases: string[] }> = [
  { canonicalNorm: 'van hoc viet nam', aliases: ['vh viet nam', 'van hoc vn', 'vhvn'] },
  { canonicalNorm: 'van hoc kinh dien', aliases: ['vh kinh dien', 'kinh dien', 'co dien'] },
  { canonicalNorm: 'van hoc hien dai', aliases: ['vh hien dai', 'van hoc nuoc ngoai', 'tieu thuyet hien dai', 'vh nuoc ngoai'] },
  { canonicalNorm: 'van hoc thieu nhi', aliases: ['vh thieu nhi', 'thieu nhi', 'truyen thieu nhi', 'sach thieu nhi'] },
  { canonicalNorm: 'tieu thuyet lang man', aliases: ['lang man', 'tinh cam', 'tieu thuyet tinh cam', 'ngon tinh'] },
  { canonicalNorm: 'trinh tham', aliases: ['trinh tham kinh di', 'trinh tham ly ky', 'hinh su', 'kinh di'] },
  { canonicalNorm: 'gia tuong', aliases: ['gia tuong ky ao', 'ky ao', 'vien tuong', 'khoa hoc vien tuong', 'fantasy', 'sci fi'] },
  { canonicalNorm: 'tan van', aliases: ['tan van tuy but', 'tuy but', 'tap van'] },
  { canonicalNorm: 'hoi ky', aliases: ['hoi ky tu truyen', 'tu truyen', 'tieu su'] },
  { canonicalNorm: 'lich su', aliases: ['lich su dia ly', 'su hoc'] },
  { canonicalNorm: 'triet hoc', aliases: ['triet hoc ton giao', 'triet'] },
  { canonicalNorm: 'tam ly', aliases: ['tam ly hoc', 'tam li', 'tam li hoc'] },
  { canonicalNorm: 'ky nang song', aliases: ['ky nang', 'ki nang song', 'ki nang', 'phat trien ban than', 'self help', 'tu duy'] },
  { canonicalNorm: 'kinh te', aliases: ['kinh te tai chinh', 'tai chinh', 'dau tu', 'tai chinh dau tu', 'kinh te hoc'] },
  { canonicalNorm: 'quan tri kinh doanh', aliases: ['quan tri', 'kinh doanh', 'khoi nghiep', 'lanh dao', 'marketing', 'quan tri lanh dao'] },
  { canonicalNorm: 'khoa hoc', aliases: ['khoa hoc tu nhien', 'khoa hoc cong nghe'] },
  { canonicalNorm: 'y hoc suc khoe', aliases: ['y hoc', 'suc khoe', 'dinh duong', 'cham soc suc khoe'] },
  { canonicalNorm: 'giao duc gia dinh', aliases: ['giao duc', 'gia dinh', 'nuoi day con', 'giao duc con'] },
  { canonicalNorm: 'nghe thuat doi song', aliases: ['nghe thuat', 'doi song', 'van hoa nghe thuat', 'am thuc du lich'] },
  { canonicalNorm: 'chung', aliases: ['khac', 'tong hop', 'chua phan loai'] },
];

function getSortedTokenKey(normalizedStr: string): string {
  return normalizedStr
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Tìm thể loại khớp nhất trong danh sách hiện có nếu không thực sự khác biệt
 * (trùng tên, khác hoa/thường, thiếu/sai dấu tiếng Việt, đảo vế, từ đồng nghĩa/rút gọn hoặc lỗi gõ nhẹ).
 */
export function findClosestExistingCategory(
  rawInput: string,
  candidates: string[]
): string | null {
  const trimmed = String(rawInput || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return 'Chung';

  const cleanCandidates = Array.from(
    new Set(candidates.map((c) => String(c || '').trim()).filter(Boolean))
  );
  if (cleanCandidates.length === 0) return null;

  // 1. Khớp chính xác (không phân biệt hoa/thường)
  const lowerInput = trimmed.toLowerCase();
  const exactMatch = cleanCandidates.find((c) => c.toLowerCase() === lowerInput);
  if (exactMatch) return exactMatch;

  // 2. Khớp sau khi bỏ dấu, bỏ dấu gạch/ký tự nối và chuẩn hóa chính tả (i/y, qui/quy)
  const normInput = normalizeForComparison(trimmed);
  if (!normInput) return 'Chung';

  for (const cand of cleanCandidates) {
    if (normalizeForComparison(cand) === normInput) {
      return cand;
    }
  }

  // 3. Khớp đảo vế cụm từ (ví dụ: "Sức khỏe - Y học" -> "Y học - Sức khỏe", "Kinh doanh quản trị" -> "Quản trị - Kinh doanh")
  const inputSortedTokens = getSortedTokenKey(normInput);
  if (inputSortedTokens.includes(' ')) {
    for (const cand of cleanCandidates) {
      if (getSortedTokenKey(normalizeForComparison(cand)) === inputSortedTokens) {
        return cand;
      }
    }
  }

  // 4. Khớp qua bảng đồng nghĩa / tên rút gọn chuẩn
  const noToneInput = removeVietnameseTones(trimmed).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const group of CATEGORY_ALIAS_GROUPS) {
    if (group.aliases.includes(normInput) || group.aliases.includes(noToneInput)) {
      const targetCand = cleanCandidates.find(
        (c) => normalizeForComparison(c) === group.canonicalNorm
      );
      if (targetCand) return targetCand;
    }
  }

  // 5. Khớp lỗi chính tả gõ phím nhẹ với độ tương đồng rất cao
  let bestCand: string | null = null;
  let bestSim = 0;

  for (const cand of cleanCandidates) {
    const normCand = normalizeForComparison(cand);
    const sim = stringSimilarity(normInput, normCand);
    const dist = levenshteinDistance(normInput, normCand);
    const isMinorTypo =
      sim >= 0.85 ||
      (normInput.length >= 6 && normCand.length >= 6 && dist <= 1) ||
      (normInput.length >= 11 && normCand.length >= 11 && dist <= 2);

    if (isMinorTypo && sim > bestSim) {
      bestSim = sim;
      bestCand = cand;
    }
  }

  return bestCand;
}

export interface ResolveCategoryResult {
  resolvedCategory: string;
  isNewCategory: boolean;
  wasAutoCorrected: boolean;
  updatedCategoriesList: string[];
}

/**
 * Đối chiếu thể loại người dùng sửa/nhập với kho thể loại hiện tại:
 * - Nếu không thực sự khác biệt: tự sửa về thể loại đúng nhất đã có.
 * - Nếu hoàn toàn khác biệt: bổ sung thể loại mới vào danh sách phân loại của kho
 *   (ưu tiên thay thế 1 thể loại mặc định chưa có sách nào nếu đang ở trần 20 thể loại,
 *    nhưng luôn bảo toàn mọi thể loại đang có sách).
 */
export function resolveCategoryForSave(
  inputCategory: string,
  currentCategories: string[],
  books: BookRecord[],
  defaultCategories: string[] = []
): ResolveCategoryResult {
  const cleanCurrent = Array.from(
    new Set(currentCategories.map((c) => String(c || '').trim()).filter(Boolean))
  );
  const categoriesFromBooks = Array.from(
    new Set(books.map((b) => String(b.category || '').trim()).filter(Boolean))
  );
  const allKnownCandidates = Array.from(new Set([...cleanCurrent, ...categoriesFromBooks]));

  const rawTrimmed = String(inputCategory || '').replace(/\s+/g, ' ').trim();
  if (!rawTrimmed) {
    return {
      resolvedCategory: 'Chung',
      isNewCategory: false,
      wasAutoCorrected: false,
      updatedCategoriesList: cleanCurrent.length > 0 ? cleanCurrent : ['Chung'],
    };
  }

  // 1. So sánh xem có trùng / tương đương với thể loại đã có hay không
  const matched = findClosestExistingCategory(rawTrimmed, allKnownCandidates);
  if (matched) {
    const wasAutoCorrected = matched !== rawTrimmed;
    // Đảm bảo matched có mặt trong categoriesList
    let nextList = [...cleanCurrent];
    if (!nextList.includes(matched)) {
      nextList = insertCategoryIntoList(nextList, matched, books, defaultCategories);
    }
    return {
      resolvedCategory: matched,
      isNewCategory: false,
      wasAutoCorrected,
      updatedCategoriesList: nextList,
    };
  }

  // 2. Thể loại hoàn toàn mới -> định dạng gọn gàng và bổ sung vào kho thể loại
  const formattedNew = formatCustomCategoryName(rawTrimmed);
  const updatedList = insertCategoryIntoList(cleanCurrent, formattedNew, books, defaultCategories);

  return {
    resolvedCategory: formattedNew,
    isNewCategory: true,
    wasAutoCorrected: false,
    updatedCategoriesList: updatedList,
  };
}

/**
 * Chèn thêm 1 thể loại mới vào danh sách phân loại, giữ vị trí 'Chung' ở cuối.
 * Nếu đang chạm trần 20 thể loại, tự động nhường chỗ từ các thể loại mặc định đang có 0 sách.
 */
export function insertCategoryIntoList(
  currentList: string[],
  newCategory: string,
  books: BookRecord[],
  defaultCategories: string[] = []
): string[] {
  const list = Array.from(new Set(currentList.map((c) => String(c || '').trim()).filter(Boolean)));
  if (list.includes(newCategory)) return list;

  // Đếm số sách hiện tại theo thể loại để biết thể loại nào đang trống (0 cuốn)
  const counts = new Map<string, number>();
  for (const b of books) {
    const cat = String(b.category || 'Chung').trim() || 'Chung';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }

  const defaultSet = new Set(defaultCategories);

  // Nếu đã >= 20 mục, tìm 1 thể loại mặc định đang có 0 cuốn (khác 'Chung') để nhường chỗ
  if (list.length >= 20 && newCategory !== 'Chung') {
    let removeIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const cat = list[i];
      if (cat !== 'Chung' && defaultSet.has(cat) && (counts.get(cat) || 0) === 0) {
        removeIdx = i;
        break;
      }
    }
    // Nếu không có mục mặc định 0 cuốn, thử tìm bất kỳ mục 0 cuốn khác 'Chung'
    if (removeIdx === -1) {
      for (let i = list.length - 1; i >= 0; i--) {
        const cat = list[i];
        if (cat !== 'Chung' && (counts.get(cat) || 0) === 0) {
          removeIdx = i;
          break;
        }
      }
    }
    if (removeIdx !== -1) {
      list.splice(removeIdx, 1);
    }
  }

  const chungIdx = list.indexOf('Chung');
  if (chungIdx !== -1 && newCategory !== 'Chung') {
    list.splice(chungIdx, 0, newCategory);
  } else {
    list.push(newCategory);
  }

  return list;
}

/**
 * Tự động đồng bộ các thể loại đang có sách (ví dụ từ máy khác sync Drive về)
 * vào danh sách categoriesList của kho nếu chưa có.
 */
export function syncCategoriesWithBooks(
  currentCategories: string[],
  books: BookRecord[],
  defaultCategories: string[] = []
): { categories: string[]; hasChanges: boolean } {
  let list = Array.from(
    new Set(currentCategories.map((c) => String(c || '').trim()).filter(Boolean))
  );
  let hasChanges = false;

  for (const book of books) {
    const rawCat = String(book.category || '').trim();
    if (!rawCat || rawCat === 'Chung') continue;
    if (list.includes(rawCat)) continue;

    // Kiểm tra xem có khớp gần đúng với mục sẵn có không; nếu thực sự mới thì bổ sung vào list
    const matched = findClosestExistingCategory(rawCat, list);
    if (!matched) {
      list = insertCategoryIntoList(list, rawCat, books, defaultCategories);
      hasChanges = true;
    }
  }

  return { categories: list, hasChanges };
}
