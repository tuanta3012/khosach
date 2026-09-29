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
 * Kiểm tra xem 1 bản ghi sách mới có bị trùng với kho sách hiện tại hay không
 * Sử dụng Fuzzy Matching thông minh trên Tên sách (title) và Tác giả (author)
 */
export function checkDuplicateBook(
  item: { title: string; author?: string },
  existingBooks: BookRecord[],
  threshold = 0.75
): { isDuplicate: boolean; matchedBook?: BookRecord; score: number } {
  if (!item.title) return { isDuplicate: false, score: 0 };

  const normTitle = normalizeForComparison(item.title);
  const normTitleClean = normalizeForComparison(item.title.replace(/\(.*?\)/g, ''));
  const normAuthor = normalizeForComparison(item.author || '');

  let bestMatch: BookRecord | undefined = undefined;
  let highestScore = 0;

  for (const book of existingBooks) {
    const bookTitleNorm = normalizeForComparison(book.title);
    const bookTitleClean = normalizeForComparison(book.title.replace(/\(.*?\)/g, ''));

    // So sánh full title lẫn title đã lọc bỏ ngoặc
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
 * Phân nhóm tất cả các sách trùng lặp để hiển thị cho người dùng lựa chọn cuốn muốn giữ lại
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
