import * as XLSX from 'xlsx';
import { BookRecord, DriveBackupPayload } from '../types';

/**
 * Xuất danh mục kho sách thành chuỗi JSON chuẩn
 */
export function exportBooksToJson(books: BookRecord[]): string {
  const payload: DriveBackupPayload = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    totalBooks: books.length,
    books,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Đọc và parse dữ liệu kho sách từ chuỗi JSON
 */
export function importBooksFromJson(jsonStr: string): BookRecord[] {
  try {
    const data = JSON.parse(jsonStr);
    if (Array.isArray(data)) {
      return normalizeBookList(data);
    }
    if (data && Array.isArray(data.books)) {
      return normalizeBookList(data.books);
    }
    throw new Error('Định dạng JSON không đúng cấu trúc danh mục sách.');
  } catch (err: any) {
    throw new Error('Lỗi giải mã JSON: ' + (err?.message || String(err)));
  }
}

/**
 * Xuất danh mục kho sách thành chuỗi CSV (hỗ trợ Tiếng Việt UTF-8 with BOM)
 */
export function exportBooksToCsv(books: BookRecord[]): string {
  const headers = ['Tên sách', 'Tác giả', 'Thể loại', 'Nhà xuất bản'];

  const rows = books.map((b) => [
    `"${(b.title || '').replace(/"/g, '""')}"`,
    `"${(b.author || '').replace(/"/g, '""')}"`,
    `"${(b.category || 'Chung').replace(/"/g, '""')}"`,
    `"${(b.publisher || '').replace(/"/g, '""')}"`,
  ]);

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  return '\uFEFF' + csvContent; // Thêm UTF-8 BOM cho Excel mở tiếng Việt không bị lỗi font
}

/**
 * Xuất danh mục kho sách sang file Excel .xlsx
 */
export function exportBooksToExcel(books: BookRecord[], filename = 'kho_sach_ca_nhan.xlsx') {
  const data = books.map((b, idx) => ({
    STT: idx + 1,
    'Tên sách': b.title,
    'Tác giả': b.author,
    'Thể loại': b.category || 'Chung',
    'Nhà xuất bản': b.publisher || '',
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Kho Sách');
  XLSX.writeFile(workbook, filename);
}

/**
 * Import từ Excel hoặc CSV
 */
export function parseBooksFromExcelBuffer(buffer: ArrayBuffer): BookRecord[] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rawRows: any[] = XLSX.utils.sheet_to_json(worksheet);

  const books: BookRecord[] = [];
  const now = Date.now();

  for (const row of rawRows) {
    const title = row['Tên sách'] || row['Title'] || row['ten_sach'] || row['title'];
    if (!title) continue;

    const author = row['Tác giả'] || row['Author'] || row['tac_gia'] || row['author'] || 'Khuyết danh';
    const publisher = row['Nhà xuất bản'] || row['Publisher'] || row['nxb'] || row['publisher'] || '';
    const category = row['Thể loại'] || row['Category'] || row['the_loai'] || 'Chung';
    const id = row['Mã ID'] || row['ID'] || row['id'] || 'book_' + Math.random().toString(36).substring(2, 9);

    books.push({
      id: String(id),
      title: String(title).trim(),
      author: String(author).trim(),
      publisher: String(publisher).trim(),
      category: String(category).trim(),
      created_at: now,
      updated_at: now,
    });
  }

  return books;
}

function normalizeBookList(list: any[]): BookRecord[] {
  const now = Date.now();
  return list.map((item, i) => ({
    id: item.id || `book_${now}_${i}`,
    title: item.title || 'Sách chưa đặt tên',
    author: item.author || 'Khuyết danh',
    publisher: item.publisher || '',
    category: item.category || 'Chung',
    created_at: item.created_at || now,
    updated_at: item.updated_at || now,
  }));
}
