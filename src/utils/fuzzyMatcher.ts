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
  return noDau.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
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

  // Roman numerals: I -> 1, II -> 2, etc. (chỉ xét từ 1 đến 20)
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
    xvi: '16',
    xvii: '17',
    xviii: '18',
    xix: '19',
    xx: '20',
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

  // Nếu là số: loại bỏ số 0 ở đầu (01 -> 1)
  if (/^\d+$/.test(v)) {
    const num = parseInt(v, 10);
    // Nếu là năm (>= 1800) -> KHÔNG PHẢI SỐ TẬP!
    if (num >= 1800) return '';
    return String(num);
  }

  if (v === 'thuong' || v === 'ha' || v === 'trung') {
    return v;
  }

  return v;
}

/**
 * Bóc tách thông tin tập, ấn bản, và tên sách gốc sạch sẽ
 */
export function extractBookMetadata(rawTitle: string): {
  cleanTitle: string;
  volume: string | null;
  seriesPrefix: string | null;
  seriesSubtitle: string | null;
  editionNote: string | null;
} {
  if (!rawTitle) {
    return { cleanTitle: '', volume: null, seriesPrefix: null, seriesSubtitle: null, editionNote: null };
  }

  let title = rawTitle.trim();
  let volume: string | null = null;
  let editionNote: string | null = null;

  // 1. Bóc tách và loại bỏ các ghi chú tái bản / năm xuất bản / định dạng bìa trong ngoặc đơn hoặc ngoặc vuông
  // Ví dụ: (Tái bản 2023), (2021), [Bìa cứng], (NXB Kim Đồng), (Bản dịch mới), (Bộ 3 cuốn)
  const editionRegex = /[\(\[]\s*(?:tái bản|tai ban|nxb|in lần|in lan|năm|nam|bìa|bia|khổ|kho|bản dịch|ban dich|trọn bộ|tron bo|boxset|đặc biệt|dac biet|kèm|kem|\d{4})[^)\]]*[\)\]]/gi;
  const editionMatches = title.match(editionRegex);
  if (editionMatches) {
    editionNote = editionMatches.join(' ');
    title = title.replace(editionRegex, ' ').trim();
  }

  // Loại bỏ các năm xuất bản đứng lẻ ở cuối tiêu đề: ví dụ " - 2022", " 2020", " [2021]"
  title = title.replace(/(?:[-–—\s,]+)\b(19\d\d|20\d\d)\b\s*$/g, '').trim();

  // Chuẩn hóa dấu gạch ngang
  const normTitle = removeVietnameseTones(title).toLowerCase().replace(/[–—−]/g, '-');

  // 2. Nhận diện từ khóa tập rõ ràng: tập, vol, volume, quyển, phần, cuốn, part, book, hồi, bộ
  // Ví dụ: "Tập 1", "Tập I", "Vol. 2", "Phần 3", "Quyển Thượng", "Tập một"
  const keywordRegex = /\b(?:tap|vol(?:ume)?|quyen|phan|cuon|part|book|hoi|bo)\s*(?:so\s*)?([0-9]+|[ivxlcdm]+|thuong|trung|ha|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\b/i;
  const matchKeyword = normTitle.match(keywordRegex);

  if (matchKeyword) {
    const rawVol = matchKeyword[1];
    const canon = canonicalizeVolume(rawVol);
    if (canon) {
      volume = canon;
      // Xóa phần tập ra khỏi title
      const origKeywordRegex = /(?:[-–—\s,(:/[]+)?\b(?:t[aậ]p|vol(?:ume)?|quy[eể]n|ph[aầ]n|cu[oố]n|part|book|h[oồ]i|b[oộ])\s*(?:s[oố]\s*)?(?:[0-9]+|[ivxlcdm]+|th[uư][oợ]ng|trung|h[aạ]|m[oộ]t|hai|ba|b[oố]n|n[aă]m|s[aá]u|b[aả]y|t[aá]m|ch[ií]n|m[uư][oờ]i)\b[\)\]]?/i;
      title = title.replace(origKeywordRegex, ' ').trim();
    }
  } else {
    // 3. Nhận diện ký hiệu viết tắt ở cuối tiêu đề: ví dụ " - T1", " - T.2", " - Q1", " #1", " - 1", " - 2"
    // Chú ý: [0-9]{1,2} chỉ lấy số từ 1 đến 99, TUYỆT ĐỐI không lấy năm 2023!
    const shorthandRegex = /(?:[-–—\s,(:/[]+)(?:t|q|v)?\.?\s*#?\s*([0-9]{1,2}|[ivxlcdm]{1,5})\s*[\)\]]?$/i;
    const matchShorthand = normTitle.match(shorthandRegex);
    if (matchShorthand) {
      const rawVol = matchShorthand[1];
      const canon = canonicalizeVolume(rawVol);
      if (canon) {
        volume = canon;
        title = title.replace(/(?:[-–—\s,(:/[]+)(?:t|q|v)?\.?\s*#?\s*(?:[0-9]{1,2}|[ivxlcdm]{1,5})\s*[\)\]]?$/i, ' ').trim();
      }
    }
  }

  // Dọn dẹp dấu câu thừa ở cuối tiêu đề sau khi bóc tách tập
  title = title.replace(/[-–—\s,(:/[\]]+$/, '').replace(/^[-–—\s,(:/[\]]+/, '').trim();

  // 4. Phân tích Series Prefix & Subtitle:
  // Ví dụ: "Harry Potter và Hòn đá Phù thủy", "Chúa tể những chiếc nhẫn: Hai tòa tháp", "Sapiens - Lược sử loài người"
  let seriesPrefix: string | null = null;
  let seriesSubtitle: string | null = null;

  // Dấu phân cách: " - ", ": ", " – ", " — "
  const separatorMatch = title.match(/^(.*?)\s*[-–—:]\s*(.*)$/);
  if (separatorMatch && separatorMatch[1].trim().length >= 3 && separatorMatch[2].trim().length >= 2) {
    seriesPrefix = separatorMatch[1].trim();
    seriesSubtitle = separatorMatch[2].trim();
  }

  return {
    cleanTitle: title || rawTitle.trim(),
    volume,
    seriesPrefix,
    seriesSubtitle,
    editionNote,
  };
}

/**
 * Tương thích ngược: Trích xuất thông tin tập (Tập 1, Tập 2, Vol, Phần, Quyển...)
 */
export function extractVolumeInfo(rawTitle: string): { volume: string | null; cleanTitle: string } {
  const meta = extractBookMetadata(rawTitle);
  return { volume: meta.volume, cleanTitle: meta.cleanTitle };
}

/**
 * So sánh 2 tên tác giả xem có phải cùng 1 người hay tương thích không
 */
export function areAuthorsCompatible(
  author1?: string,
  author2?: string
): { compatible: boolean; confidence: number; isKnownDifferent: boolean } {
  const a1 = normalizeForComparison(author1 || '');
  const a2 = normalizeForComparison(author2 || '');

  // Nếu một trong 2 chưa có tác giả hoặc là khuyết danh -> Tương thích (không coi là khác tác giả)
  const isAnonymous1 = !a1 || a1 === 'khuyet danh' || a1 === 'chua ro' || a1 === 'nhieu tac gia';
  const isAnonymous2 = !a2 || a2 === 'khuyet danh' || a2 === 'chua ro' || a2 === 'nhieu tac gia';

  if (isAnonymous1 || isAnonymous2) {
    return { compatible: true, confidence: 0.5, isKnownDifferent: false };
  }

  // Tên giống hệt nhau
  if (a1 === a2) {
    return { compatible: true, confidence: 1.0, isKnownDifferent: false };
  }

  // Kiểm tra tên viết tắt / họ tên: ví dụ "j k rowling" vs "rowling" hoặc "dale carnegie" vs "d carnegie"
  const words1 = a1.split(/\s+/);
  const words2 = a2.split(/\s+/);

  const lastName1 = words1[words1.length - 1];
  const lastName2 = words2[words2.length - 1];
  const firstName1 = words1[0];
  const firstName2 = words2[0];

  if (lastName1 === lastName2 && (firstName1 === firstName2 || words1.length === 1 || words2.length === 1)) {
    return { compatible: true, confidence: 0.85, isKnownDifferent: false };
  }

  const sim = stringSimilarity(a1, a2);
  if (sim >= 0.70) {
    return { compatible: true, confidence: sim, isKnownDifferent: false };
  }

  // Rõ ràng là 2 tác giả khác nhau (ví dụ: Trần Trọng Kim vs Đào Duy Anh, Murakami vs Dale Carnegie)
  return { compatible: false, confidence: sim, isKnownDifferent: true };
}

/**
 * Thuật toán kiểm tra trùng lặp sách thông minh chuẩn xác cao (High-Precision Smart Deduplicator)
 */
export function isTrueDuplicate(
  bookA: { title: string; author?: string; publisher?: string },
  bookB: { title: string; author?: string; publisher?: string }
): { isDuplicate: boolean; score: number; reason: string } {
  if (!bookA.title || !bookB.title) {
    return { isDuplicate: false, score: 0, reason: 'Thiếu tên sách' };
  }

  // 1. KIỂM TRA TÁC GIẢ: Nếu cả 2 cuốn đều có tác giả và là 2 tác giả KHÁC HẲN NHAU -> TUYỆT ĐỐI KHÔNG TRÙNG!
  const authorCheck = areAuthorsCompatible(bookA.author, bookB.author);
  if (authorCheck.isKnownDifferent) {
    return {
      isDuplicate: false,
      score: 0,
      reason: `Khác tác giả: "${bookA.author}" vs "${bookB.author}"`,
    };
  }

  // 2. BÓC TÁCH METADATA (TẬP, NĂM, PHỤ ĐỀ)
  const metaA = extractBookMetadata(bookA.title);
  const metaB = extractBookMetadata(bookB.title);

  // 3. BẢO VỆ SÁCH NHIỀU TẬP (Multi-volume Series Protection):
  // - Nếu cả 2 cuốn đều có số tập và số tập KHÁC NHAU (Tập 1 vs Tập 2, Thượng vs Hạ, I vs II) -> TUYỆT ĐỐI KHÔNG TRÙNG!
  if (metaA.volume && metaB.volume && metaA.volume !== metaB.volume) {
    return {
      isDuplicate: false,
      score: 0,
      reason: `Khác tập: Tập ${metaA.volume} vs Tập ${metaB.volume}`,
    };
  }

  // - Nếu một cuốn là tập 2 trở lên (hoặc Trung/Hạ) và cuốn kia là tập 1 hoặc không ghi số tập -> TUYỆT ĐỐI KHÔNG TRÙNG!
  const isLaterVol = (v: string | null) => v !== null && v !== '1' && v !== 'thuong';
  if ((isLaterVol(metaA.volume) && !metaB.volume) || (isLaterVol(metaB.volume) && !metaA.volume)) {
    return {
      isDuplicate: false,
      score: 0,
      reason: `Một cuốn là phần tiếp theo (${metaA.volume || metaB.volume}), cuốn kia không ghi tập`,
    };
  }

  // 4. KIỂM TRA CÙNG SERIES NHƯNG KHÁC TỰA CON / PHỤ ĐỀ
  // Ví dụ:
  // "Harry Potter và Hòn đá Phù thủy" vs "Harry Potter và Phòng chứa Bí mật"
  // "Lịch sử văn minh: Ấn Độ" vs "Lịch sử văn minh: Ả Rập"
  // "Chúa tể những chiếc nhẫn: Đoàn hộ nhẫn" vs "Chúa tể những chiếc nhẫn: Hai tòa tháp"
  const normCleanA = normalizeForComparison(metaA.cleanTitle);
  const normCleanB = normalizeForComparison(metaB.cleanTitle);

  // Kiểm tra nếu có phân cách "Series: Subtitle" hoặc "Series - Subtitle"
  if (metaA.seriesPrefix && metaB.seriesPrefix) {
    const prefixSim = stringSimilarity(metaA.seriesPrefix, metaB.seriesPrefix);
    if (prefixSim >= 0.85) {
      if (metaA.seriesSubtitle && metaB.seriesSubtitle) {
        const subSim = stringSimilarity(metaA.seriesSubtitle, metaB.seriesSubtitle);
        if (subSim < 0.6) {
          return {
            isDuplicate: false,
            score: 0,
            reason: `Cùng bộ "${metaA.seriesPrefix}" nhưng khác tựa con: "${metaA.seriesSubtitle}" vs "${metaB.seriesSubtitle}"`,
          };
        }
      }
    }
  }

  // Kiểm tra trường hợp Harry Potter hoặc series có tiền tố dài chung (> 12 ký tự)
  const wordsA = normCleanA.split(' ');
  const wordsB = normCleanB.split(' ');

  let commonPrefixWords = 0;
  while (
    commonPrefixWords < wordsA.length &&
    commonPrefixWords < wordsB.length &&
    wordsA[commonPrefixWords] === wordsB[commonPrefixWords]
  ) {
    commonPrefixWords++;
  }

  if (commonPrefixWords >= 2) {
    const restA = wordsA.slice(commonPrefixWords).join(' ');
    const restB = wordsB.slice(commonPrefixWords).join(' ');
    if (restA.length >= 4 && restB.length >= 4) {
      const restSim = stringSimilarity(restA, restB);
      if (restSim < 0.5) {
        return {
          isDuplicate: false,
          score: 0,
          reason: `Cùng tựa đề tiền tố nhưng nội dung sau khác biệt: "${restA}" vs "${restB}"`,
        };
      }
    }
  }

  // 5. BẪY CHUỖI CON (SUBSTRING TRAP):
  // "Kinh tế học" vs "Kinh tế học vi mô"
  // "Tâm lý học" vs "Tâm lý học tội phạm"
  if (normCleanA !== normCleanB) {
    const isSubstring = normCleanA.includes(normCleanB) || normCleanB.includes(normCleanA);
    if (isSubstring) {
      const shortStr = normCleanA.length < normCleanB.length ? normCleanA : normCleanB;
      const longStr = normCleanA.length < normCleanB.length ? normCleanB : normCleanA;

      const diffWords = longStr.replace(shortStr, '').trim().split(/\s+/).filter(Boolean);
      const stopWords = new Set(['tap', 'quyen', 'phan', 'cuon', 'vol', 'nxb', 'ban', 'sach', 'nam', 'in']);
      const meaningfulDiffWords = diffWords.filter((w) => !stopWords.has(w) && w.length >= 2);

      if (meaningfulDiffWords.length >= 1) {
        return {
          isDuplicate: false,
          score: 0,
          reason: `Tiêu đề khác biệt từ ngữ trọng yếu: "${meaningfulDiffWords.join(' ')}"`,
        };
      }
    }
  }

  // 6. SO SÁNH ĐỘ TƯƠNG ĐỒNG THỰC SỰ TRÊN CLEAN TITLE
  const titleSim = stringSimilarity(normCleanA, normCleanB);

  // So sánh thêm tên gốc nếu có ngoặc đơn song ngữ: ví dụ "Nhà Giả Kim (The Alchemist)" vs "Nhà Giả Kim"
  const rawSim = stringSimilarity(
    normalizeForComparison(bookA.title),
    normalizeForComparison(bookB.title)
  );

  const bestTitleScore = Math.max(titleSim, rawSim);

  // 1. Clean Title giống hệt nhau sau khi chuẩn hóa (100%) -> TRÙNG
  if (normCleanA === normCleanB && normCleanA.length > 0) {
    return {
      isDuplicate: true,
      score: 100,
      reason: 'Tên sách hoàn toàn trùng khớp',
    };
  }

  // 2. Trùng tên chính sau khi lược bỏ toàn bộ phần trong ngoặc đơn/ngoặc vuông (như phụ đề song ngữ)
  // Ví dụ: "Nhà Giả Kim (The Alchemist)" vs "Nhà Giả Kim"
  const noParensA = normalizeForComparison(metaA.cleanTitle.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, ''));
  const noParensB = normalizeForComparison(metaB.cleanTitle.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, ''));
  if (noParensA && noParensB && noParensA === noParensB) {
    return {
      isDuplicate: true,
      score: 98,
      reason: 'Trùng tên chính (khác biệt phụ đề trong ngoặc)',
    };
  }

  // Kiểm tra tên trong ngoặc khớp tên cuốn kia (ví dụ: "The Alchemist" vs "Nhà Giả Kim (The Alchemist)")
  const parenMatchA = metaA.cleanTitle.match(/\((.*?)\)/)?.[1];
  const parenMatchB = metaB.cleanTitle.match(/\((.*?)\)/)?.[1];
  if (parenMatchA && normalizeForComparison(parenMatchA) === normCleanB) {
    return {
      isDuplicate: true,
      score: 95,
      reason: 'Trùng tên tiếng nước ngoài trong ngoặc',
    };
  }
  if (parenMatchB && normalizeForComparison(parenMatchB) === normCleanA) {
    return {
      isDuplicate: true,
      score: 95,
      reason: 'Trùng tên tiếng nước ngoài trong ngoặc',
    };
  }

  // 3. KIỂM TRA CHÍNH TẢ CẤP ĐỘ TỪ (Strict Word-Level Integrity):
  // BẢO VỆ CHỐNG TRÙNG NHẦM: "Không gia đình" vs "Trong gia đình" (Hector Malot)
  // Trong tiếng Việt, các từ ngắn (< 6 ký tự như "không" vs "trong", "đỏ" vs "đen", "đất" vs "cát")
  // là các TỪ HOÀN TOÀN KHÁC NHAU VỀ NGHĨA. Tuyệt đối không được coi là lỗi chính tả!
  const tokensA = normCleanA.split(/\s+/).filter(Boolean);
  const tokensB = normCleanB.split(/\s+/).filter(Boolean);

  if (tokensA.length === tokensB.length && tokensA.length > 0) {
    let diffWordCount = 0;
    let diffA = '';
    let diffB = '';

    for (let i = 0; i < tokensA.length; i++) {
      const wA = tokensA[i];
      const wB = tokensB[i];

      if (wA !== wB) {
        // Chỉ chấp nhận là lỗi gõ / lỗi OCR nếu từ đó là từ dài (>= 6 ký tự) và chỉ sai khác tối đa 1 ký tự
        const isMinorTypoInLongWord = wA.length >= 6 && wB.length >= 6 && levenshteinDistance(wA, wB) <= 1;
        if (!isMinorTypoInLongWord) {
          diffWordCount++;
          diffA = wA;
          diffB = wB;
        }
      }
    }

    // Nếu chỉ có đúng 1 từ dài có lỗi chính tả 1 ký tự (ví dụ tên riêng nước ngoài), các từ khác giống hệt 100%
    if (diffWordCount === 0 && tokensA.length >= 2) {
      return {
        isDuplicate: true,
        score: 90,
        reason: 'Trùng tên sách (sai khác 1 ký tự gõ nhầm ở từ dài)',
      };
    } else if (diffWordCount > 0) {
      return {
        isDuplicate: false,
        score: Math.round(titleSim * 100),
        reason: `Khác biệt từ ngữ: "${diffA}" vs "${diffB}"`,
      };
    }
  }

  return {
    isDuplicate: false,
    score: Math.round(bestTitleScore * 100),
    reason: `Độ tương đồng không đủ điều kiện trùng (${Math.round(bestTitleScore * 100)}%)`,
  };
}

/**
 * Kiểm tra xem 1 bản ghi sách mới có bị trùng với kho sách hiện tại hay không
 */
export function checkDuplicateBook(
  item: { title: string; author?: string; publisher?: string },
  existingBooks: BookRecord[],
  threshold = 0.75
): { isDuplicate: boolean; matchedBook?: BookRecord; score: number; reason?: string } {
  if (!item.title || !existingBooks || existingBooks.length === 0) {
    return { isDuplicate: false, score: 0 };
  }

  let bestMatch: BookRecord | undefined = undefined;
  let highestScore = 0;
  let matchReason = '';

  for (const book of existingBooks) {
    if (!book.title) continue;

    const res = isTrueDuplicate(
      { title: item.title, author: item.author, publisher: item.publisher },
      { title: book.title, author: book.author, publisher: book.publisher }
    );

    if (res.isDuplicate && res.score > highestScore) {
      highestScore = res.score;
      bestMatch = book;
      matchReason = res.reason;
    }
  }

  return {
    isDuplicate: highestScore >= (threshold * 100),
    matchedBook: highestScore >= (threshold * 100) ? bestMatch : undefined,
    score: highestScore,
    reason: matchReason,
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
      { title: draft.title, author: draft.author, publisher: draft.publisher },
      existingBooks
    );
    return {
      ...draft,
      isDuplicate,
      duplicateMatchTitle: matchedBook ? `${matchedBook.title} (${matchedBook.author || 'Khuyết danh'})` : undefined,
      confidence: score,
    };
  });
}

/**
 * Tính điểm đầy đủ của bản ghi sách để ưu tiên giữ lại bản ghi có nhiều thông tin nhất
 */
export function calculateBookRichness(book: BookRecord): number {
  let score = 0;
  if (book.title && book.title.trim().length > 0) score += 5;
  // Chuỗi có dấu tiếng Việt chuẩn được ưu tiên hơn chuỗi không dấu
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(book.title)) score += 2;
  if (book.author && book.author !== 'Khuyết danh' && book.author !== 'Chưa rõ') score += 4;
  if (book.publisher && book.publisher.trim().length > 0) score += 3;
  if (book.category && book.category !== 'Chung' && book.category.trim().length > 0) score += 2;
  if (book.is_ai_normalized) score += 5;
  return score;
}

export interface DuplicateGroup {
  id: string;
  books: BookRecord[];
  reason?: string;
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
      const { isDuplicate } = checkDuplicateBook(
        { title: book.title, author: book.author, publisher: book.publisher },
        [existing],
        0.75
      );
      return isDuplicate;
    });

    if (matchIndex === -1) {
      result.push({ ...book });
    } else {
      mergedCount++;
      const existing = result[matchIndex];
      // Giữ lại bản ghi đầy đủ hơn
      const prefersNew = calculateBookRichness(book) > calculateBookRichness(existing);
      result[matchIndex] = {
        ...existing,
        title: prefersNew ? book.title : existing.title,
        author: (book.author && book.author !== 'Khuyết danh' && book.author !== 'Chưa rõ') ? book.author : existing.author,
        publisher: book.publisher || existing.publisher,
        category: (book.category && book.category !== 'Chung') ? book.category : existing.category,
        is_ai_normalized: existing.is_ai_normalized || book.is_ai_normalized,
        updated_at: Date.now(),
      };
    }
  }

  return { cleanBooks: result, mergedCount };
}

/**
 * Phân nhóm tất cả các sách trùng lặp để hiển thị cho người dùng lựa chọn cuốn muốn giữ lại (đồng bộ)
 */
export function groupDuplicateBooks(books: BookRecord[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const visited = new Set<string>();
  const total = books.length;

  for (let i = 0; i < total; i++) {
    const book = books[i];
    if (visited.has(book.id)) continue;

    const dupBooks: BookRecord[] = [book];
    let groupReason = '';

    for (let j = i + 1; j < total; j++) {
      const other = books[j];
      if (visited.has(other.id)) continue;

      const res = isTrueDuplicate(
        { title: book.title, author: book.author, publisher: book.publisher },
        { title: other.title, author: other.author, publisher: other.publisher }
      );

      if (res.isDuplicate) {
        dupBooks.push(other);
        visited.add(other.id);
        if (!groupReason) groupReason = res.reason;
      }
    }

    if (dupBooks.length > 1) {
      visited.add(book.id);
      // Sắp xếp cuốn có thông tin đầy đủ nhất lên đầu
      dupBooks.sort((a, b) => calculateBookRichness(b) - calculateBookRichness(a));

      groups.push({
        id: `group_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 5)}`,
        books: dupBooks,
        reason: groupReason,
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
    // Nhường quyền cho giao diện React sau mỗi 8 cuốn để cập nhật % mượt mà trên nút
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
    let groupReason = '';

    for (let j = i + 1; j < total; j++) {
      const other = books[j];
      if (visited.has(other.id)) continue;

      const res = isTrueDuplicate(
        { title: book.title, author: book.author, publisher: book.publisher },
        { title: other.title, author: other.author, publisher: other.publisher }
      );

      if (res.isDuplicate) {
        dupBooks.push(other);
        visited.add(other.id);
        if (!groupReason) groupReason = res.reason;
      }
    }

    if (dupBooks.length > 1) {
      visited.add(book.id);
      // Sắp xếp cuốn có thông tin đầy đủ nhất lên đầu
      dupBooks.sort((a, b) => calculateBookRichness(b) - calculateBookRichness(a));

      groups.push({
        id: `group_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 5)}`,
        books: dupBooks,
        reason: groupReason,
      });
    }
  }

  if (onProgress) {
    onProgress(100, total, total);
  }

  return groups;
}
