import { BookRecord, DraftBookItem } from '../types';

/**
 * Loại bỏ dấu tiếng Việt để tìm kiếm không dấu siêu tốc và chính xác
 */
export function removeVietnameseTones(str: string): string {
  if (!str) return '';
  str = str.toLowerCase();
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, 'a');
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, 'e');
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, 'i');
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, 'o');
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, 'u');
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, 'y');
  str = str.replace(/đ/g, 'd');
  // Kết hợp các ký tự đặc biệt
  str = str.replace(/[\u0300\u0301\u0303\u0309\u0323]/g, '');
  str = str.replace(/[\u02C6\u0306\u031B]/g, '');
  return str.trim();
}

/**
 * Chuẩn hóa chuỗi giữ nguyên ký tự Unicode (Tiếng Trung, Nhật, Hàn, Anh...)
 */
export function normalizeForComparison(raw: string): string {
  if (!raw) return '';
  const noDau = removeVietnameseTones(raw);
  // Giữ nguyên các ký tự chữ cái Unicode (\p{L}), số (\p{N}) và khoảng trắng
  return noDau.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * Tính khoảng cách Levenshtein giữa 2 chuỗi
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Tính độ tương đồng giữa 2 chuỗi (0.0 đến 1.0) - Hỗ trợ đa ngôn ngữ
 */
export function stringSimilarity(str1: string, str2: string): number {
  const s1 = normalizeForComparison(str1);
  const s2 = normalizeForComparison(str2);

  if (!s1 && !s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  if (s1 === s2) return 1.0;

  // Kiểm tra nếu 1 chuỗi chứa chuỗi còn lại (ví dụ tên dịch kèm ngoặc)
  if (s1.includes(s2) || s2.includes(s1)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    if (minLen >= 2 && minLen / maxLen >= 0.35) {
      return 0.88;
    }
  }

  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(s1, s2);
  return 1 - dist / maxLen;
}

/**
 * Chuẩn hóa số tập thành chuỗi định danh duy nhất (ví dụ: "Tập 1", "Tập I", "Vol 1" -> "1")
 */
export function canonicalizeVolume(rawVol: string): string {
  if (!rawVol) return '';
  const v = rawVol.toLowerCase().trim();

  const romanMap: Record<string, string> = {
    i: '1',
    ii: '2',
    iii: '3',
    iv: '4',
    v: '5',
    vi: '6',
    vii: '7',
    viii: '8',
    ix: '9',
    x: '10',
    xi: '11',
    xii: '12',
    xiii: '13',
    xiv: '14',
    xv: '15',
  };
  if (romanMap[v]) return romanMap[v];

  const wordMap: Record<string, string> = {
    mot: '1',
    nhat: '1',
    hai: '2',
    nhi: '2',
    ba: '3',
    tam: '3',
    bon: '4',
    tu: '4',
    nam: '5',
    ngu: '5',
    sau: '6',
    luc: '6',
    bay: '7',
    that: '7',
    bat: '8',
    chin: '9',
    cuu: '9',
    muoi: '10',
  };
  if (wordMap[v]) return wordMap[v];

  if (/^\d+$/.test(v)) {
    return String(parseInt(v, 10));
  }

  if (v === 'thuong' || v === 'ha' || v === 'trung') {
    return v;
  }

  return v;
}

/**
 * Trích xuất thông tin tập (Tập 1, Tập 2, Vol, Phần, Quyển...) và tiêu đề sạch không chứa số tập
 */
export function extractVolumeInfo(rawTitle: string): { volume: string | null; cleanTitle: string } {
  if (!rawTitle) return { volume: null, cleanTitle: '' };

  const norm = removeVietnameseTones(rawTitle).toLowerCase().trim();
  const standardized = norm.replace(/[–—−]/g, '-');

  let rawVol: string | null = null;
  let clean = rawTitle;

  // 1. Khớp các từ khóa tập phổ biến: tap, vol, quyen, phan, part, bo, hoi
  const keywordRegex = /\b(?:tap|vol(?:ume)?|quyen|phan|part|bo|hoi)\s*(?:so\s*)?([0-9]+|[ivxlcdm]+|thuong|trung|ha|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\b/i;
  const matchKeyword = standardized.match(keywordRegex);

  if (matchKeyword) {
    rawVol = matchKeyword[1];
    const origKeywordRegex = /(?:[-–—\s,(:/[]+)?\b(?:t[aậ]p|vol(?:ume)?|quy[eể]n|ph[aầ]n|part|b[oộ]|h[oồ]i)\s*(?:s[oố]\s*)?(?:[0-9]+|[ivxlcdm]+|th[uư][oợ]ng|trung|h[aạ]|m[oộ]t|hai|ba|b[oố]n|n[aă]m|s[aá]u|b[aả]y|t[aá]m|ch[ií]n|m[uư][oờ]i)\b[\)\]]?/i;
    clean = clean.replace(origKeywordRegex, '').trim();
  } else {
    // 2. Khớp các ký hiệu viết tắt ở cuối tiêu đề: ví dụ " - T1", " - T2", "T.1", "T.2", "Q.1", hoặc " - 1", " - 2", " #1", " #2", "(1)", "(2)"
    const shorthandRegex = /(?:[-–—\s,(:/[]+)(?:t|q|v)?\.?\s*#?\s*([0-9]+|[ivxlcdm]+)\s*[\)\]]?$/i;
    const matchShorthand = standardized.match(shorthandRegex);
    if (matchShorthand) {
      rawVol = matchShorthand[1];
      clean = clean.replace(/(?:[-–—\s,(:/[]+)(?:t|q|v)?\.?\s*#?\s*(?:[0-9]+|[ivxlcdm]+)\s*[\)\]]?$/i, '').trim();
    }
  }

  clean = clean.replace(/[-–—\s,(:/[\]]+$/, '').trim();
  const volume = rawVol ? canonicalizeVolume(rawVol) : null;
  return { volume, cleanTitle: clean || rawTitle };
}

/**
 * Kiểm tra xem 1 bản ghi sách mới có bị trùng với kho sách hiện tại hay không
 * Sử dụng Fuzzy Matching thông minh trên Tên sách (title) và Tác giả (author)
 * BẢO VỆ CHỐNG NHẬN DIỆN SAI CÁC BỘ SÁCH NHIỀU TẬP (Tập 1, Tập 2, Vol 1, Vol 2...)
 */
export function checkDuplicateBook(
  item: { title: string; author?: string },
  existingBooks: BookRecord[],
  threshold = 0.75
): { isDuplicate: boolean; matchedBook?: BookRecord; score: number } {
  if (!item.title) return { isDuplicate: false, score: 0 };

  const volItem = extractVolumeInfo(item.title);
  const normTitle = normalizeForComparison(item.title);
  const normTitleClean = normalizeForComparison(volItem.cleanTitle.replace(/\(.*?\)/g, ''));
  const normAuthor = normalizeForComparison(item.author || '');

  let bestMatch: BookRecord | undefined = undefined;
  let highestScore = 0;

  for (const book of existingBooks) {
    if (!book.title) continue;

    const volBook = extractVolumeInfo(book.title);

    // BẢO VỆ SÁCH NHIỀU TẬP (Multi-volume Series Protection):
    // 1. Nếu cả 2 cuốn đều có chỉ số tập và KHÁC NHAU (ví dụ Tập 1 vs Tập 2, Thượng vs Hạ) -> Tuyệt đối KHÔNG TRÙNG!
    if (volItem.volume && volBook.volume && volItem.volume !== volBook.volume) {
      continue;
    }

    // 2. Nếu một cuốn là tập tiếp theo (Tập 2, 3, 4... hoặc Hạ/Trung) trong khi cuốn kia không ghi số tập -> Tuyệt đối KHÔNG TRÙNG!
    const isContinuingVol = (v: string | null) => v !== null && v !== '1' && v !== 'thuong';
    if (
      (isContinuingVol(volItem.volume) && !volBook.volume) ||
      (isContinuingVol(volBook.volume) && !volItem.volume)
    ) {
      continue;
    }

    const bookTitleNorm = normalizeForComparison(book.title);
    const bookTitleClean = normalizeForComparison(volBook.cleanTitle.replace(/\(.*?\)/g, ''));

    // So sánh full title lẫn clean title (đã lọc số tập và ngoặc đơn)
    const titleScore1 = stringSimilarity(normTitle, bookTitleNorm);
    const titleScore2 = stringSimilarity(normTitleClean, bookTitleClean);
    const titleScore3 = stringSimilarity(normTitle, bookTitleClean);
    const titleScore4 = stringSimilarity(normTitleClean, bookTitleNorm);

    // Bổ sung so sánh phần tiếng Việt trong ngoặc đơn nếu có
    const matchInParen1 = item.title.match(/\((.*?)\)/);
    const matchInParen2 = book.title.match(/\((.*?)\)/);
    let parenScore = 0;
    if (matchInParen1 && matchInParen2) {
      parenScore = stringSimilarity(matchInParen1[1], matchInParen2[1]);
    } else if (matchInParen1) {
      parenScore = stringSimilarity(matchInParen1[1], book.title);
    } else if (matchInParen2) {
      parenScore = stringSimilarity(item.title, matchInParen2[1]);
    }

    const titleScore = Math.max(titleScore1, titleScore2, titleScore3, titleScore4, parenScore);

    let totalScore = titleScore;

    if (normAuthor && book.author) {
      const bookAuthorNorm = normalizeForComparison(book.author);
      const isMissingAuthor =
        normAuthor === 'khuyet danh' ||
        normAuthor === 'chua ro' ||
        bookAuthorNorm === 'khuyet danh' ||
        bookAuthorNorm === 'chua ro';

      if (isMissingAuthor) {
        totalScore = titleScore;
      } else {
        const authorScore = stringSimilarity(normAuthor, bookAuthorNorm);
        if (authorScore >= 0.8) {
          totalScore = titleScore * 0.6 + authorScore * 0.4;
        } else {
          totalScore = titleScore * 0.8 + authorScore * 0.2;
        }
      }
    }

    if (totalScore > highestScore) {
      highestScore = totalScore;
      bestMatch = book;
    }
  }

  return {
    isDuplicate: highestScore >= threshold,
    matchedBook: highestScore >= threshold ? bestMatch : undefined,
    score: Math.round(highestScore * 100),
  };
}

/**
 * Kiểm tra trùng lặp hàng loạt cho Draft Table
 */
export function flagDuplicateDrafts(
  drafts: DraftBookItem[],
  existingBooks: BookRecord[]
): DraftBookItem[] {
  return drafts.map((draft) => {
    const { isDuplicate, matchedBook, score } = checkDuplicateBook(
      { title: draft.title, author: draft.author },
      existingBooks
    );
    return {
      ...draft,
      isDuplicate,
      duplicateMatchTitle: matchedBook ? `${matchedBook.title} (${matchedBook.author})` : undefined,
      confidence: score,
    };
  });
}

/**
 * Tự động tìm và gộp tất cả các sách bị trùng lặp trong toàn bộ kho sách
 */
export function deduplicateBookList(books: BookRecord[]): { cleanBooks: BookRecord[]; mergedCount: number } {
  const result: BookRecord[] = [];
  let mergedCount = 0;

  for (const book of books) {
    if (!book.title) continue;

    const matchIndex = result.findIndex((existing) => {
      const { isDuplicate } = checkDuplicateBook({ title: book.title, author: book.author }, [existing], 0.75);
      return isDuplicate;
    });

    if (matchIndex === -1) {
      result.push({ ...book });
    } else {
      mergedCount++;
      const existing = result[matchIndex];
      // Ưu tiên chọn tên sách đầy đủ hơn (có chữ tượng hình / tên trong ngoặc đơn / dài hơn)
      const prefersNewTitle =
        (book.title.includes('(') && !existing.title.includes('(')) ||
        (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(book.title) && !/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(existing.title)) ||
        book.title.length > existing.title.length;

      result[matchIndex] = {
        ...existing,
        title: prefersNewTitle ? book.title : existing.title,
        author: (book.author && book.author !== 'Khuyết danh') ? book.author : existing.author,
        publisher: book.publisher || existing.publisher,
        category: (book.category && book.category !== 'Chung') ? book.category : existing.category,
        is_ai_normalized: existing.is_ai_normalized || book.is_ai_normalized,
        updated_at: Date.now(),
      };
    }
  }

  return { cleanBooks: result, mergedCount };
}

export interface DuplicateGroup {
  id: string;
  books: BookRecord[];
}

/**
 * Phân nhóm tất cả các sách trùng lặp để hiển thị cho người dùng lựa chọn cuốn muốn giữ lại (đồng bộ)
 */
export function groupDuplicateBooks(books: BookRecord[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const visited = new Set<string>();

  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    if (visited.has(book.id)) continue;

    const dupBooks: BookRecord[] = [book];
    
    for (let j = i + 1; j < books.length; j++) {
      const other = books[j];
      if (visited.has(other.id)) continue;

      const { isDuplicate } = checkDuplicateBook(
        { title: book.title, author: book.author },
        [other],
        0.75
      );

      if (isDuplicate) {
        dupBooks.push(other);
        visited.add(other.id);
      }
    }

    if (dupBooks.length > 1) {
      visited.add(book.id);
      groups.push({
        id: `group_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 5)}`,
        books: dupBooks,
      });
    }
  }

  return groups;
}

/**
 * Phân nhóm tất cả các sách trùng lặp bất đồng bộ có báo cáo tiến độ % (Non-blocking Progressive Scanner)
 * Nhường quyền xử lý cho UI Event Loop để giao diện không bị giật lag, hiển thị tiến trình mượt mà
 */
export async function groupDuplicateBooksAsync(
  books: BookRecord[],
  onProgress?: (percent: number, current: number, total: number) => void
): Promise<DuplicateGroup[]> {
  const groups: DuplicateGroup[] = [];
  const visited = new Set<string>();
  const total = books.length;

  for (let i = 0; i < total; i++) {
    // Nhường quyền cho giao diện React sau mỗi 8 cuốn để cập nhật thanh tiến trình và % mượt mà
    if (i % 8 === 0 || i === total - 1) {
      const percent = Math.min(100, Math.round(((i + 1) / total) * 100));
      if (onProgress) {
        onProgress(percent, i + 1, total);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const book = books[i];
    if (visited.has(book.id)) continue;

    const dupBooks: BookRecord[] = [book];

    for (let j = i + 1; j < total; j++) {
      const other = books[j];
      if (visited.has(other.id)) continue;

      const { isDuplicate } = checkDuplicateBook(
        { title: book.title, author: book.author },
        [other],
        0.75
      );

      if (isDuplicate) {
        dupBooks.push(other);
        visited.add(other.id);
      }
    }

    if (dupBooks.length > 1) {
      visited.add(book.id);
      groups.push({
        id: `group_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 5)}`,
        books: dupBooks,
      });
    }
  }

  if (onProgress) {
    onProgress(100, total, total);
  }

  return groups;
}
