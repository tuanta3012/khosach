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
 * Tính độ tương đồng giữa 2 chuỗi (0.0 đến 1.0)
 */
export function stringSimilarity(str1: string, str2: string): number {
  const s1 = removeVietnameseTones(str1 || '').replace(/[^a-z0-9]/g, '');
  const s2 = removeVietnameseTones(str2 || '').replace(/[^a-z0-9]/g, '');

  if (!s1 && !s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  if (s1 === s2) return 1.0;

  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(s1, s2);
  return 1 - dist / maxLen;
}

/**
 * Kiểm tra xem 1 bản ghi sách mới có bị trùng với kho sách hiện tại hay không
 * Sử dụng Fuzzy Matching trên Tên sách (title) và Tác giả (author)
 */
export function checkDuplicateBook(
  item: { title: string; author?: string },
  existingBooks: BookRecord[],
  threshold = 0.8
): { isDuplicate: boolean; matchedBook?: BookRecord; score: number } {
  if (!item.title) return { isDuplicate: false, score: 0 };

  const normTitle = removeVietnameseTones(item.title);
  const normAuthor = removeVietnameseTones(item.author || '');

  let bestMatch: BookRecord | undefined = undefined;
  let highestScore = 0;

  for (const book of existingBooks) {
    const bookTitleNorm = removeVietnameseTones(book.title);
    const titleScore = stringSimilarity(normTitle, bookTitleNorm);

    let totalScore = titleScore;
    if (normAuthor && book.author) {
      const bookAuthorNorm = removeVietnameseTones(book.author);
      const authorScore = stringSimilarity(normAuthor, bookAuthorNorm);
      totalScore = titleScore * 0.7 + authorScore * 0.3;
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
