import JSZip from 'jszip';
import {
  BookExportProgress,
  EpubTranslatableSegment,
  EpubTranslationChunk,
  ParsedEpubData,
  ParsedPdfData,
  PdfBlockTag,
  PdfChapterInfo,
  PdfExtractedAsset,
  PdfParsedPage,
  PdfTranslatedBlock,
  SerializedInlineTag,
} from '../types';

const MAX_CHUNK_CHARS = 3500;
const MAX_CHUNK_SEGMENTS = 32;

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'SVG',
  'MATH',
  'PRE',
  'NOSCRIPT',
  'AUDIO',
  'VIDEO',
  'CANVAS',
  'IFRAME',
  'TEMPLATE',
]);

const VOID_OR_ATOMIC_INLINE_TAGS = new Set([
  'BR',
  'IMG',
  'HR',
  'WBR',
  'INPUT',
  'SOURCE',
  'EMBED',
  'SVG',
  'MATH',
]);

const STRUCTURAL_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

const LEAF_PROSE_BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'DT',
  'DD',
  'TD',
  'TH',
  'CAPTION',
  'FIGCAPTION',
  'SUMMARY',
]);

const CONTAINER_BLOCK_TAGS = new Set([
  'LI',
  'DIV',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'NAV',
  'ADDRESS',
  'DETAILS',
  'FIGURE',
]);

function normalizeZipPath(rawPath: string): string {
  return (rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveEpubPath(baseDir: string, relativeHref: string): string {
  const cleanHref = (relativeHref || '').split('#')[0].split('?')[0].trim();
  if (!cleanHref) return '';
  try {
    const baseUrl = `https://epub.local/${normalizeZipPath(baseDir)}`;
    const resolved = new URL(cleanHref, baseUrl).pathname.replace(/^\/+/, '');
    return decodeURIComponent(resolved);
  } catch {
    return normalizeZipPath(`${baseDir}${cleanHref}`);
  }
}

function findZipEntry(zip: JSZip, targetPath: string): JSZip.JSZipObject | null {
  const normalized = normalizeZipPath(targetPath);
  if (zip.files[normalized]) return zip.files[normalized];

  try {
    const decoded = decodeURIComponent(normalized);
    if (zip.files[decoded]) return zip.files[decoded];
  } catch {}

  const lower = normalized.toLowerCase();
  for (const key of Object.keys(zip.files)) {
    if (key.toLowerCase() === lower) {
      return zip.files[key];
    }
  }
  return null;
}

function hasTranslatableText(text: string): boolean {
  if (!text) return false;
  const cleaned = text.replace(/\u00a0/g, ' ').trim();
  if (!cleaned) return false;
  return /\p{L}/u.test(cleaned);
}

export function appendVnSuffix(title: string): string {
  const clean = (title || '').trim();
  if (!clean) return 'Sach_EPUB_VN';
  if (/_vn$/i.test(clean)) return clean;
  return `${clean}_VN`;
}

function getElementsByLocalName(root: Document | Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  const result: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const name = (el.localName || el.tagName || '').toLowerCase().replace(/^.*:/, '');
    if (name === target) {
      result.push(el);
    }
  }
  return result;
}

function parseXmlDoc(xmlText: string): Document | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  return doc;
}

function parseXhtmlOrHtmlDoc(content: string): {
  doc: Document;
  isXmlMode: boolean;
  xmlDecl: string;
  doctypeDecl: string;
} {
  const xmlDeclMatch = content.match(/^\s*(<\?xml[^?>]*\?>)/i);
  const doctypeMatch = content.match(/(<!DOCTYPE[^>]*>)/i);
  const xmlDecl = xmlDeclMatch ? xmlDeclMatch[1] : '';
  const doctypeDecl = doctypeMatch ? doctypeMatch[1] : '';

  const parser = new DOMParser();
  const xhtmlDoc = parser.parseFromString(content, 'application/xhtml+xml');
  if (xhtmlDoc.getElementsByTagName('parsererror').length === 0 && xhtmlDoc.documentElement) {
    return { doc: xhtmlDoc, isXmlMode: true, xmlDecl, doctypeDecl };
  }

  const htmlDoc = parser.parseFromString(content, 'text/html');
  return { doc: htmlDoc, isXmlMode: false, xmlDecl, doctypeDecl };
}

function serializeXhtmlOrHtmlDoc(
  doc: Document,
  isXmlMode: boolean,
  xmlDecl: string,
  doctypeDecl: string
): string {
  const serializer = new XMLSerializer();
  let serialized = serializer.serializeToString(doc);

  if (isXmlMode) {
    if (xmlDecl && !serialized.trimStart().startsWith('<?xml')) {
      serialized = `${xmlDecl}\n${serialized}`;
    }
    if (doctypeDecl && !/<!DOCTYPE/i.test(serialized)) {
      if (serialized.trimStart().startsWith('<?xml')) {
        serialized = serialized.replace(/(<\?xml[^?>]*\?>)/i, `$1\n${doctypeDecl}`);
      } else {
        serialized = `${doctypeDecl}\n${serialized}`;
      }
    }
    return serialized;
  }

  if (doctypeDecl && !/<!DOCTYPE/i.test(serialized)) {
    return `${doctypeDecl}\n${serialized}`;
  }
  return serialized;
}

function containsChildStructuralBlock(el: Element): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    const tag = (child.localName || child.tagName || '').toUpperCase();
    if (STRUCTURAL_BLOCK_TAGS.has(tag)) {
      return true;
    }
    if (containsChildStructuralBlock(child)) {
      return true;
    }
  }
  return false;
}

interface ExtractedDomSlot {
  nodes: Node[];
  isTitleElement?: boolean;
  hostElement?: Element;
}

/**
 * Duyệt xác định (deterministic) mọi khối văn bản có thể dịch trong tài liệu HTML/XHTML.
 * Giữ nguyên thứ tự node tuyệt đối giữa bước trích xuất và bước lắp ráp lại.
 */
function collectTranslatableDomSlots(doc: Document): ExtractedDomSlot[] {
  const slots: ExtractedDomSlot[] = [];

  const titleEl = doc.querySelector('head > title') || doc.getElementsByTagName('title')[0];
  if (titleEl && hasTranslatableText(titleEl.textContent || '')) {
    slots.push({
      nodes: Array.from(titleEl.childNodes),
      isTitleElement: true,
      hostElement: titleEl,
    });
  }

  const rootBody = doc.body || doc.documentElement;
  if (!rootBody) return slots;

  const visitElement = (el: Element) => {
    const tag = (el.localName || el.tagName || '').toUpperCase();
    if (SKIP_TAGS.has(tag)) return;

    if (LEAF_PROSE_BLOCK_TAGS.has(tag)) {
      if (!containsChildStructuralBlock(el)) {
        if (hasTranslatableText(el.textContent || '')) {
          slots.push({ nodes: Array.from(el.childNodes), hostElement: el });
        }
        return;
      }
      walkMixedContainer(el);
      return;
    }

    if (CONTAINER_BLOCK_TAGS.has(tag) || tag === 'BODY') {
      if (tag !== 'BODY' && !containsChildStructuralBlock(el)) {
        if (hasTranslatableText(el.textContent || '')) {
          slots.push({ nodes: Array.from(el.childNodes), hostElement: el });
        }
        return;
      }
      walkMixedContainer(el);
      return;
    }

    // Các bảng, danh sách, details... duyệt đệ quy vào từng phần tử con
    for (let i = 0; i < el.children.length; i++) {
      visitElement(el.children[i]);
    }
  };

  const walkMixedContainer = (container: Element) => {
    let inlineRun: Node[] = [];

    const flushInlineRun = () => {
      if (inlineRun.length === 0) return;
      const combinedText = inlineRun.map((n) => n.textContent || '').join('');
      if (hasTranslatableText(combinedText)) {
        slots.push({ nodes: [...inlineRun] });
      }
      inlineRun = [];
    };

    const childNodes = Array.from(container.childNodes);
    for (const child of childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as Element;
        const childTag = (childEl.localName || childEl.tagName || '').toUpperCase();
        if (
          SKIP_TAGS.has(childTag) ||
          STRUCTURAL_BLOCK_TAGS.has(childTag) ||
          LEAF_PROSE_BLOCK_TAGS.has(childTag) ||
          CONTAINER_BLOCK_TAGS.has(childTag) ||
          childTag === 'UL' ||
          childTag === 'OL' ||
          childTag === 'DL' ||
          childTag === 'TABLE' ||
          containsChildStructuralBlock(childEl)
        ) {
          flushInlineRun();
          visitElement(childEl);
          continue;
        }
      }
      if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE) {
        inlineRun.push(child);
      }
    }
    flushInlineRun();
  };

  visitElement(rootBody);
  return slots;
}

function serializeNodesToTokenText(nodes: Node[]): {
  tokenText: string;
  tagRegistry: SerializedInlineTag[];
  domTagNodes: Map<number, Element>;
} {
  let nextTagId = 0;
  const tagRegistry: SerializedInlineTag[] = [];
  const domTagNodes = new Map<number, Element>();

  const walk = (nodeList: Node[]): string => {
    let out = '';
    for (const node of nodeList) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tagUpper = (el.localName || el.tagName || '').toUpperCase();
        const tagId = nextTagId++;
        const attrs: Array<[string, string]> = [];
        for (let i = 0; i < el.attributes.length; i++) {
          const attr = el.attributes[i];
          attrs.push([attr.name, attr.value]);
        }

        const isVoid =
          VOID_OR_ATOMIC_INLINE_TAGS.has(tagUpper) || el.childNodes.length === 0;

        tagRegistry.push({
          id: tagId,
          tagName: el.tagName,
          attrs,
          isVoid,
        });
        domTagNodes.set(tagId, el);

        if (isVoid) {
          out += `[[V${tagId}]]`;
        } else {
          out += `[[E${tagId}]]${walk(Array.from(el.childNodes))}[[/E${tagId}]]`;
        }
      }
    }
    return out;
  };

  const tokenText = walk(nodes).replace(/[ \t]+/g, ' ').trim();
  return { tokenText, tagRegistry, domTagNodes };
}

function rebuildFragmentFromTokenText(
  doc: Document,
  translatedText: string,
  domTagNodes: Map<number, Element>
): DocumentFragment {
  const rootFrag = doc.createDocumentFragment();
  const stack: Array<{ tagId: number | null; container: Node }> = [
    { tagId: null, container: rootFrag },
  ];
  const usedVoidIds = new Set<number>();

  const tokenRegex = /\[\[(\/?E\d+|V\d+)\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(translatedText)) !== null) {
    if (match.index > lastIndex) {
      const textChunk = translatedText.slice(lastIndex, match.index);
      stack[stack.length - 1].container.appendChild(doc.createTextNode(textChunk));
    }

    const token = match[1];
    if (token.startsWith('V')) {
      const id = parseInt(token.slice(1), 10);
      const origEl = domTagNodes.get(id);
      if (origEl) {
        usedVoidIds.add(id);
        stack[stack.length - 1].container.appendChild(origEl.cloneNode(true));
      }
    } else if (token.startsWith('E')) {
      const id = parseInt(token.slice(1), 10);
      const origEl = domTagNodes.get(id);
      if (origEl) {
        const cloned = origEl.cloneNode(false);
        stack[stack.length - 1].container.appendChild(cloned);
        stack.push({ tagId: id, container: cloned });
      }
    } else if (token.startsWith('/E')) {
      const id = parseInt(token.slice(2), 10);
      let foundIdx = -1;
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagId === id) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx !== -1) {
        stack.length = foundIdx;
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < translatedText.length) {
    const trailing = translatedText.slice(lastIndex);
    stack[stack.length - 1].container.appendChild(doc.createTextNode(trailing));
  }

  // Bảo vệ toàn vẹn ảnh/svg/hr: nếu AI vô tình làm rơi mất thẻ atomic như <img>, tự động gắn lại ở cuối khối
  for (const [id, origEl] of domTagNodes.entries()) {
    const tagUpper = (origEl.localName || origEl.tagName || '').toUpperCase();
    if ((tagUpper === 'IMG' || tagUpper === 'SVG') && !usedVoidIds.has(id)) {
      rootFrag.appendChild(doc.createTextNode(' '));
      rootFrag.appendChild(origEl.cloneNode(true));
    }
  }

  return rootFrag;
}

function replaceSlotNodesInDom(
  doc: Document,
  slot: ExtractedDomSlot,
  translatedTokenText: string,
  domTagNodes: Map<number, Element>
): void {
  if (slot.isTitleElement && slot.hostElement) {
    const stripped = translatedTokenText.replace(/\[\[(\/?E\d+|V\d+)\]\]/g, '').trim();
    if (stripped) {
      slot.hostElement.textContent = stripped;
    }
    return;
  }

  if (slot.nodes.length === 0) return;

  const parent = slot.nodes[0].parentNode;
  if (!parent) return;

  const anchor = slot.nodes[0];
  const fragment = rebuildFragmentFromTokenText(doc, translatedTokenText, domTagNodes);

  // Giữ khoảng trắng đầu/cuối nếu inline run chen giữa các khối con
  const firstNodeText = slot.nodes[0].nodeType === Node.TEXT_NODE ? slot.nodes[0].nodeValue || '' : '';
  const lastNode = slot.nodes[slot.nodes.length - 1];
  const lastNodeText = lastNode.nodeType === Node.TEXT_NODE ? lastNode.nodeValue || '' : '';
  if (/^\s+/.test(firstNodeText) && fragment.firstChild) {
    fragment.insertBefore(doc.createTextNode(' '), fragment.firstChild);
  }
  if (/\s+$/.test(lastNodeText)) {
    fragment.appendChild(doc.createTextNode(' '));
  }

  parent.insertBefore(fragment, anchor);
  for (const node of slot.nodes) {
    if (node.parentNode === parent) {
      parent.removeChild(node);
    }
  }
}

export function buildEpubChunks(segments: EpubTranslatableSegment[]): EpubTranslationChunk[] {
  const chunks: EpubTranslationChunk[] = [];
  let currentIds: number[] = [];
  let currentChars = 0;
  let currentFile = '';

  const flush = () => {
    if (currentIds.length === 0) return;
    chunks.push({
      chunkIndex: chunks.length,
      filePath: currentFile,
      segmentIds: currentIds,
      totalChars: currentChars,
    });
    currentIds = [];
    currentChars = 0;
  };

  for (const seg of segments) {
    const fileChanged = currentFile && currentFile !== seg.filePath;
    const exceedsBudget =
      currentIds.length > 0 &&
      (currentChars + seg.charLength > MAX_CHUNK_CHARS || currentIds.length >= MAX_CHUNK_SEGMENTS);

    if (fileChanged || exceedsBudget) {
      flush();
    }

    currentFile = seg.filePath;
    currentIds.push(seg.segId);
    currentChars += seg.charLength;
  }
  flush();

  return chunks;
}

/**
 * Đọc, giải nén và trích xuất toàn bộ nội dung cần dịch từ file EPUB (OPF + NCX + NAV + toàn bộ Spine).
 */
export async function parseEpubFile(arrayBuffer: ArrayBuffer): Promise<ParsedEpubData> {
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 1. Đọc META-INF/container.xml để lấy đường dẫn file .opf
  let opfPath = '';
  const containerEntry = findZipEntry(zip, 'META-INF/container.xml');
  if (containerEntry) {
    const containerXml = await containerEntry.async('string');
    const containerDoc = parseXmlDoc(containerXml);
    if (containerDoc) {
      const rootfiles = getElementsByLocalName(containerDoc, 'rootfile');
      const fullPath = rootfiles[0]?.getAttribute('full-path');
      if (fullPath) opfPath = normalizeZipPath(fullPath);
    }
  }

  if (!opfPath) {
    const fallbackOpf = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.opf'));
    if (!fallbackOpf) {
      throw new Error('Không tìm thấy file cấu trúc OPF trong tệp EPUB.');
    }
    opfPath = fallbackOpf;
  }

  const opfEntry = findZipEntry(zip, opfPath);
  if (!opfEntry) {
    throw new Error(`Không đọc được file cấu trúc sách (${opfPath}).`);
  }

  const opfDirSlashIdx = opfPath.lastIndexOf('/');
  const opfDir = opfDirSlashIdx >= 0 ? opfPath.slice(0, opfDirSlashIdx + 1) : '';

  const opfXmlText = await opfEntry.async('string');
  const opfDoc = parseXmlDoc(opfXmlText);
  if (!opfDoc) {
    throw new Error('File cấu trúc OPF của EPUB không hợp lệ.');
  }

  // 2. Lấy metadata sách
  const titleEl = getElementsByLocalName(opfDoc, 'title')[0];
  const creatorEl = getElementsByLocalName(opfDoc, 'creator')[0];
  const publisherEl = getElementsByLocalName(opfDoc, 'publisher')[0];
  const languageEl = getElementsByLocalName(opfDoc, 'language')[0];

  const bookTitle = (titleEl?.textContent || '').trim() || 'Sách EPUB';
  const bookAuthor = (creatorEl?.textContent || '').trim() || 'Khuyết danh';
  const bookPublisher = (publisherEl?.textContent || '').trim();
  const bookLanguage = (languageEl?.textContent || '').trim();

  // 3. Phân tích manifest & tìm nav.xhtml / toc.ncx
  const manifestItems = new Map<
    string,
    { path: string; mediaType: string; properties: string }
  >();
  let navPath: string | undefined;
  let ncxPath: string | undefined;

  for (const itemEl of getElementsByLocalName(opfDoc, 'item')) {
    const id = itemEl.getAttribute('id') || '';
    const href = itemEl.getAttribute('href') || '';
    const mediaType = (itemEl.getAttribute('media-type') || '').toLowerCase();
    const properties = (itemEl.getAttribute('properties') || '').toLowerCase();
    if (!id || !href) continue;

    const fullPath = resolveEpubPath(opfDir, href);
    manifestItems.set(id, { path: fullPath, mediaType, properties });

    if (properties.split(/\s+/).includes('nav')) {
      navPath = fullPath;
    }
    if (mediaType === 'application/x-dtbncx+xml') {
      ncxPath = fullPath;
    }
  }

  // 4. Lấy thứ tự đọc spine
  const spineEl = getElementsByLocalName(opfDoc, 'spine')[0];
  if (!ncxPath && spineEl) {
    const tocId = spineEl.getAttribute('toc');
    if (tocId && manifestItems.has(tocId)) {
      ncxPath = manifestItems.get(tocId)!.path;
    }
  }

  const spineFilePaths: string[] = [];
  const seenHtmlPaths = new Set<string>();
  if (spineEl) {
    for (const itemRef of getElementsByLocalName(spineEl, 'itemref')) {
      const idref = itemRef.getAttribute('idref') || '';
      const item = manifestItems.get(idref);
      if (!item) continue;
      if (
        item.mediaType.includes('html') ||
        /\.(xhtml|html|htm)$/i.test(item.path)
      ) {
        if (!seenHtmlPaths.has(item.path)) {
          seenHtmlPaths.add(item.path);
          spineFilePaths.push(item.path);
        }
      }
    }
  }

  // Fallback nếu spine rỗng: lấy các file HTML theo manifest
  if (spineFilePaths.length === 0) {
    for (const item of manifestItems.values()) {
      if (item.mediaType.includes('html') || /\.(xhtml|html|htm)$/i.test(item.path)) {
        if (!seenHtmlPaths.has(item.path)) {
          seenHtmlPaths.add(item.path);
          spineFilePaths.push(item.path);
        }
      }
    }
  }

  const segments: EpubTranslatableSegment[] = [];
  let nextSegId = 0;

  // 5a. Giữ nguyên tên sách gốc (không gửi dịch); chỉ dịch mục lục và nội dung bên trong sách.
  // 5b. Mục lục EPUB 2 (toc.ncx)
  if (ncxPath) {
    const ncxEntry = findZipEntry(zip, ncxPath);
    if (ncxEntry) {
      const ncxText = await ncxEntry.async('string');
      const ncxDoc = parseXmlDoc(ncxText);
      if (ncxDoc) {
        const ncxTextNodes = collectNcxTextElements(ncxDoc);
        for (const el of ncxTextNodes) {
          const val = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (hasTranslatableText(val)) {
            segments.push({
              segId: nextSegId++,
              filePath: ncxPath,
              kind: 'ncx-text',
              tokenText: val,
              tagRegistry: [],
              charLength: val.length,
            });
          }
        }
      }
    }
  }

  // 5c. Toàn bộ file HTML/XHTML (nav.xhtml nếu nằm ngoài spine + toàn bộ spine theo thứ tự)
  const orderedHtmlPaths: string[] = [];
  if (navPath && !seenHtmlPaths.has(navPath)) {
    orderedHtmlPaths.push(navPath);
  }
  orderedHtmlPaths.push(...spineFilePaths);

  for (const htmlPath of orderedHtmlPaths) {
    const entry = findZipEntry(zip, htmlPath);
    if (!entry) continue;
    const rawHtml = await entry.async('string');
    const { doc } = parseXhtmlOrHtmlDoc(rawHtml);
    const slots = collectTranslatableDomSlots(doc);

    for (const slot of slots) {
      const { tokenText, tagRegistry } = serializeNodesToTokenText(slot.nodes);
      if (!hasTranslatableText(tokenText)) continue;
      segments.push({
        segId: nextSegId++,
        filePath: htmlPath,
        kind: 'html-block',
        tokenText,
        tagRegistry,
        charLength: tokenText.length,
      });
    }
  }

  if (segments.length === 0) {
    throw new Error('Không tìm thấy văn bản tiếng nước ngoài nào có thể dịch trong file EPUB này.');
  }

  const chunks = buildEpubChunks(segments);

  return {
    opfPath,
    opfDir,
    ncxPath,
    navPath,
    spineFilePaths,
    bookTitle,
    bookAuthor,
    bookPublisher,
    bookLanguage,
    segments,
    chunks,
  };
}

function collectNcxTextElements(ncxDoc: Document): Element[] {
  const result: Element[] = [];
  const navLabels = getElementsByLocalName(ncxDoc, 'navLabel');
  for (const label of navLabels) {
    const textEl = getElementsByLocalName(label, 'text')[0];
    if (textEl) result.push(textEl);
  }
  return result;
}

/**
 * Lắp ráp lại toàn bộ nội dung đã dịch (chương + mục lục + metadata) vào cấu trúc EPUB chuẩn và nén ZIP.
 */
export async function reassembleAndPackageEpub(
  parsed: ParsedEpubData,
  translatedSegments: Record<number, string>,
  rawBuffer: ArrayBuffer,
  onProgress?: (progress: BookExportProgress) => void
): Promise<{ blob: Blob; translatedTitle: string }> {
  const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  onProgress?.({
    stage: 'Đang nạp cấu trúc EPUB gốc...',
    current: 0,
    total: 100,
    percent: 2,
  });

  const sourceZip = await JSZip.loadAsync(rawBuffer);
  const outZip = new JSZip();

  // 1. Theo chuẩn EPUB OCF, file 'mimetype' BẮT BUỘC đứng đầu tiên và không nén (STORE)
  outZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // Nhóm segments theo filePath
  const segsByFile = new Map<string, EpubTranslatableSegment[]>();
  for (const seg of parsed.segments) {
    const list = segsByFile.get(seg.filePath) || [];
    list.push(seg);
    segsByFile.set(seg.filePath, list);
  }

  // Giữ nguyên tên sách gốc, chỉ thêm hậu tố _VN để phân biệt với sách gốc
  const translatedTitle = appendVnSuffix(parsed.bookTitle);

  const rewrittenFileMap = new Map<string, string>();

  // 2. Cập nhật file OPF (giữ tên sách gốc + _VN & ngôn ngữ vi)
  const opfEntry = findZipEntry(sourceZip, parsed.opfPath);
  if (opfEntry) {
    const rawOpf = await opfEntry.async('string');
    const opfDoc = parseXmlDoc(rawOpf);
    if (opfDoc) {
      const titleEl = getElementsByLocalName(opfDoc, 'title')[0];
      if (titleEl && translatedTitle) {
        titleEl.textContent = translatedTitle;
      }
      const langEl = getElementsByLocalName(opfDoc, 'language')[0];
      if (langEl) {
        langEl.textContent = 'vi';
      } else {
        const metaEl = getElementsByLocalName(opfDoc, 'metadata')[0];
        if (metaEl) {
          const dcLang = opfDoc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
          dcLang.textContent = 'vi';
          metaEl.appendChild(dcLang);
        }
      }
      rewrittenFileMap.set(opfEntry.name, new XMLSerializer().serializeToString(opfDoc));
    }
  }

  // 3. Cập nhật mục lục toc.ncx (giữ docTitle + _VN, dịch các mục navLabel)
  if (parsed.ncxPath) {
    const ncxEntry = findZipEntry(sourceZip, parsed.ncxPath);
    const ncxSegs = segsByFile.get(parsed.ncxPath) || [];
    if (ncxEntry) {
      const rawNcx = await ncxEntry.async('string');
      const ncxDoc = parseXmlDoc(rawNcx);
      if (ncxDoc) {
        const docTitle = getElementsByLocalName(ncxDoc, 'docTitle')[0];
        if (docTitle) {
          const docTitleText = getElementsByLocalName(docTitle, 'text')[0];
          if (docTitleText) {
            docTitleText.textContent = translatedTitle;
          }
        }

        if (ncxSegs.length > 0) {
          const ncxTextNodes = collectNcxTextElements(ncxDoc);
          const translatableNodeCount = ncxTextNodes.filter((el) =>
            hasTranslatableText((el.textContent || '').replace(/\s+/g, ' ').trim())
          ).length;
          // Tương thích ngược với checkpoint cũ có chứa thêm docTitle ở đầu danh sách ncxSegs
          let segIdx = ncxSegs.length === translatableNodeCount + 1 ? 1 : 0;

          for (const el of ncxTextNodes) {
            const val = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!hasTranslatableText(val)) continue;
            const matchingSeg = ncxSegs[segIdx++];
            if (matchingSeg) {
              const translated = translatedSegments[matchingSeg.segId];
              if (translated) {
                el.textContent = translated.replace(/\[\[(\/?E\d+|V\d+)\]\]/g, '').trim();
              }
            }
          }
        }
        rewrittenFileMap.set(ncxEntry.name, new XMLSerializer().serializeToString(ncxDoc));
      }
    }
  }

  // 4. Cập nhật toàn bộ file HTML/XHTML (nav.xhtml + từng chương theo spine)
  const htmlFilePaths: string[] = [];
  if (parsed.navPath && !parsed.spineFilePaths.includes(parsed.navPath)) {
    htmlFilePaths.push(parsed.navPath);
  }
  htmlFilePaths.push(...parsed.spineFilePaths);

  const totalHtml = Math.max(1, htmlFilePaths.length);
  for (let hIdx = 0; hIdx < htmlFilePaths.length; hIdx++) {
    const htmlPath = htmlFilePaths[hIdx];
    const entry = findZipEntry(sourceZip, htmlPath);
    const fileSegs = (segsByFile.get(htmlPath) || []).filter((s) => s.kind === 'html-block');
    if (entry && fileSegs.length > 0) {
      const rawHtml = await entry.async('string');
      const { doc, isXmlMode, xmlDecl, doctypeDecl } = parseXhtmlOrHtmlDoc(rawHtml);
      const slots = collectTranslatableDomSlots(doc);

      let segIdx = 0;
      for (const slot of slots) {
        const { tokenText, domTagNodes } = serializeNodesToTokenText(slot.nodes);
        if (!hasTranslatableText(tokenText)) continue;

        const matchingSeg = fileSegs[segIdx++];
        if (matchingSeg) {
          const translated = translatedSegments[matchingSeg.segId];
          if (translated && translated.trim()) {
            replaceSlotNodesInDom(doc, slot, translated, domTagNodes);
          }
        }
      }

      rewrittenFileMap.set(
        entry.name,
        serializeXhtmlOrHtmlDoc(doc, isXmlMode, xmlDecl, doctypeDecl)
      );
    }

    if ((hIdx + 1) % 3 === 0 || hIdx + 1 === htmlFilePaths.length) {
      onProgress?.({
        stage: `Đang lắp ráp chương EPUB (${hIdx + 1}/${totalHtml})...`,
        current: hIdx + 1,
        total: totalHtml,
        percent: 5 + Math.round(((hIdx + 1) / totalHtml) * 35),
      });
      await yieldTick();
    }
  }

  // 5. Ghi lại toàn bộ file vào archive mới (giữ nguyên toàn bộ ảnh, CSS, font...)
  const entryNames = Object.keys(sourceZip.files);
  const totalEntries = Math.max(1, entryNames.length);
  for (let eIdx = 0; eIdx < entryNames.length; eIdx++) {
    const name = entryNames[eIdx];
    if (name === 'mimetype') continue;
    const obj = sourceZip.files[name];
    if (obj.dir) continue;

    if (rewrittenFileMap.has(name)) {
      outZip.file(name, rewrittenFileMap.get(name)!, { compression: 'DEFLATE' });
    } else {
      const binaryData = await obj.async('uint8array');
      const alreadyCompressed = /\.(jpe?g|png|webp|gif|mp3|mp4|woff2)$/i.test(name);
      outZip.file(name, binaryData, { compression: alreadyCompressed ? 'STORE' : 'DEFLATE' });
    }

    if ((eIdx + 1) % 15 === 0) {
      onProgress?.({
        stage: `Đang đóng gói tài nguyên (${eIdx + 1}/${totalEntries})...`,
        current: eIdx + 1,
        total: totalEntries,
        percent: 40 + Math.round(((eIdx + 1) / totalEntries) * 12),
      });
      await yieldTick();
    }
  }

  onProgress?.({
    stage: 'Đang nén tệp EPUB (0%)...',
    current: 0,
    total: 100,
    percent: 52,
  });

  const blob = await outZip.generateAsync(
    {
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      const zipPct = Math.round(metadata.percent);
      const overallPct = 52 + Math.round((zipPct / 100) * 36);
      onProgress?.({
        stage: `Đang nén tệp EPUB (${zipPct}%)...`,
        current: zipPct,
        total: 100,
        percent: overallPct,
      });
    }
  );

  return { blob, translatedTitle };
}

function mapDomTagToPdfBlockTag(host?: Element): PdfBlockTag {
  if (!host) return 'p';
  const tag = (host.localName || host.tagName || '').toUpperCase();
  if (tag === 'H1') return 'h1';
  if (tag === 'H2') return 'h2';
  if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return 'h3';
  if (tag === 'BLOCKQUOTE') return 'blockquote';
  if (tag === 'PRE' || tag === 'CODE') return 'pre';
  if (tag === 'LI') {
    const parentTag = (host.parentElement?.localName || host.parentElement?.tagName || '').toUpperCase();
    return parentTag === 'OL' ? 'ol' : 'ul';
  }
  return 'p';
}

function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) break;
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    if (segLen < 2 || i + 2 + segLen > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (i + 8 < bytes.length) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        if (width > 0 && height > 0) return { width, height };
      }
      break;
    }
    i += 2 + segLen;
  }
  return null;
}

async function decodeOrConvertImageToPdfAsset(
  rawBytes: Uint8Array,
  rawExtOrMime: string,
  assetId: string,
  pageNumber: number
): Promise<PdfExtractedAsset | null> {
  if (!rawBytes || rawBytes.byteLength === 0) return null;

  const pngDims = parsePngDimensions(rawBytes);
  if (pngDims) {
    return {
      assetId,
      pageNumber,
      fileName: `${assetId}.png`,
      mimeType: 'image/png',
      data: rawBytes,
      width: pngDims.width,
      height: pngDims.height,
    };
  }

  const jpgDims = parseJpegDimensions(rawBytes);
  if (jpgDims) {
    return {
      assetId,
      pageNumber,
      fileName: `${assetId}.jpg`,
      mimeType: 'image/jpeg',
      data: rawBytes,
      width: jpgDims.width,
      height: jpgDims.height,
    };
  }

  // Chuyển đổi WEBP / GIF / SVG sang JPEG để nhúng tương thích 100% vào PDF
  if (typeof document !== 'undefined') {
    try {
      const lower = (rawExtOrMime || '').toLowerCase();
      const mimeGuess = lower.endsWith('.svg')
        ? 'image/svg+xml'
        : lower.endsWith('.webp')
        ? 'image/webp'
        : lower.endsWith('.gif')
        ? 'image/gif'
        : lower.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';

      const safeCopy = new Uint8Array(rawBytes);
      const blob = new Blob([safeCopy], { type: mimeGuess });
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('Decode image failed'));
          el.src = url;
        });
        const w = Math.max(1, img.naturalWidth || img.width || 600);
        const h = Math.max(1, img.naturalHeight || img.height || 400);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const jpgBlob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.88)
          );
          if (!jpgBlob) return null;
          const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
          return {
            assetId,
            pageNumber,
            fileName: `${assetId}.jpg`,
            mimeType: 'image/jpeg',
            data: jpgBytes,
            width: w,
            height: h,
          };
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      return null;
    }
  }

  return null;
}

function getImageSrcFromElement(el: Element): string {
  const tagUpper = (el.localName || el.tagName || '').toUpperCase();
  if (tagUpper === 'IMG') {
    return (el.getAttribute('src') || '').trim();
  }
  if (tagUpper === 'SVG') {
    const imgChild = getElementsByLocalName(el, 'image')[0];
    if (imgChild) {
      return (
        imgChild.getAttribute('href') ||
        imgChild.getAttribute('xlink:href') ||
        imgChild.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
        ''
      ).trim();
    }
  }
  return '';
}

/**
 * Chuyển đổi dữ liệu EPUB đã dịch (gồm cả văn bản và toàn bộ ảnh minh họa/bìa)
 * sang cấu trúc ParsedPdfData + translatedPages để xuất sang PDF.
 */
export async function buildPdfExportInputFromTranslatedEpub(
  parsed: ParsedEpubData,
  translatedSegments: Record<number, string>,
  rawBuffer?: ArrayBuffer
): Promise<{ parsedPdf: ParsedPdfData; translatedPages: Record<number, PdfTranslatedBlock[]> }> {
  const segsByFile = new Map<string, EpubTranslatableSegment[]>();
  for (const seg of parsed.segments) {
    if (seg.kind !== 'html-block') continue;
    const list = segsByFile.get(seg.filePath) || [];
    list.push(seg);
    segsByFile.set(seg.filePath, list);
  }

  let sourceZip: JSZip | null = null;
  if (rawBuffer && rawBuffer.byteLength > 0) {
    try {
      sourceZip = await JSZip.loadAsync(rawBuffer);
    } catch {
      sourceZip = null;
    }
  }

  const chapters: PdfChapterInfo[] = [];
  const pages: PdfParsedPage[] = [];
  const translatedPages: Record<number, PdfTranslatedBlock[]> = {};
  const assets: Record<string, PdfExtractedAsset> = {};
  const pathToAssetId = new Map<string, string>();
  let nextAssetNum = 1;

  const extractImageAsset = async (
    htmlDir: string,
    rawSrc: string,
    pageNumber: number
  ): Promise<string | null> => {
    if (!rawSrc) return null;

    if (rawSrc.startsWith('data:image/')) {
      const existingId = pathToAssetId.get(rawSrc.slice(0, 180));
      if (existingId) return existingId;
      const commaIdx = rawSrc.indexOf(',');
      if (commaIdx === -1) return null;
      const meta = rawSrc.slice(5, commaIdx).toLowerCase();
      if (!meta.includes('base64')) return null;
      try {
        const binStr = atob(rawSrc.slice(commaIdx + 1));
        const bytes = new Uint8Array(binStr.length);
        for (let k = 0; k < binStr.length; k++) {
          bytes[k] = binStr.charCodeAt(k);
        }
        const assetId = `epub_img_${nextAssetNum++}`;
        const extHint = meta.includes('png') ? '.png' : meta.includes('webp') ? '.webp' : '.jpg';
        const asset = await decodeOrConvertImageToPdfAsset(bytes, extHint, assetId, pageNumber);
        if (!asset) return null;
        assets[assetId] = asset;
        pathToAssetId.set(rawSrc.slice(0, 180), assetId);
        return assetId;
      } catch {
        return null;
      }
    }

    if (!sourceZip || /^https?:/i.test(rawSrc)) return null;
    const resolvedPath = resolveEpubPath(htmlDir, rawSrc);
    if (!resolvedPath) return null;

    const existingId = pathToAssetId.get(resolvedPath.toLowerCase());
    if (existingId) return existingId;

    const imgEntry = findZipEntry(sourceZip, resolvedPath);
    if (!imgEntry || imgEntry.dir) return null;

    try {
      const bytes = await imgEntry.async('uint8array');
      const assetId = `epub_img_${nextAssetNum++}`;
      const asset = await decodeOrConvertImageToPdfAsset(bytes, resolvedPath, assetId, pageNumber);
      if (!asset) return null;
      assets[assetId] = asset;
      pathToAssetId.set(resolvedPath.toLowerCase(), assetId);
      return assetId;
    } catch {
      return null;
    }
  };

  const spinePaths =
    parsed.spineFilePaths.length > 0 ? parsed.spineFilePaths : Array.from(segsByFile.keys());

  for (let i = 0; i < spinePaths.length; i++) {
    const htmlPath = spinePaths[i];
    const slashIdx = htmlPath.lastIndexOf('/');
    const htmlDir = slashIdx >= 0 ? htmlPath.slice(0, slashIdx + 1) : '';
    const pageNumber = i + 1;
    const fileSegs = segsByFile.get(htmlPath) || [];
    const blocks: PdfTranslatedBlock[] = [];
    const pageAssetIds: string[] = [];
    let chapterTitle = `Phần ${pageNumber}`;

    const entry = sourceZip ? findZipEntry(sourceZip, htmlPath) : undefined;
    if (entry) {
      try {
        const rawHtml = await entry.async('string');
        const { doc } = parseXhtmlOrHtmlDoc(rawHtml);
        const slots = collectTranslatableDomSlots(doc);

        const slotByFirstNode = new Map<
          Node,
          {
            slot: ExtractedDomSlot;
            matchingSeg?: EpubTranslatableSegment;
            domTagNodes: Map<number, Element>;
          }
        >();
        const slotOwnedNodes = new Set<Node>();

        let segIdx = 0;
        for (const slot of slots) {
          const { tokenText, domTagNodes } = serializeNodesToTokenText(slot.nodes);
          if (!hasTranslatableText(tokenText)) continue;
          const matchingSeg = fileSegs[segIdx++];

          if (slot.isTitleElement) {
            if (matchingSeg) {
              const rawOut = translatedSegments[matchingSeg.segId] || matchingSeg.tokenText || '';
              const titleText = rawOut
                .replace(/\[\[(\/?E\d+|V\d+)\]\]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
              if (titleText) chapterTitle = titleText;
            }
            continue;
          }

          if (slot.nodes.length > 0) {
            slotByFirstNode.set(slot.nodes[0], { slot, matchingSeg, domTagNodes });
            for (const n of slot.nodes) {
              slotOwnedNodes.add(n);
            }
          }
        }

        const rootBody = doc.body || doc.documentElement;
        const walkDom = async (node: Node): Promise<void> => {
          const slotMatch = slotByFirstNode.get(node);
          if (slotMatch) {
            const { slot, matchingSeg, domTagNodes } = slotMatch;
            if (!matchingSeg) return;

            const imgAssetByTagId = new Map<number, string>();
            for (const [tagId, el] of domTagNodes.entries()) {
              const imgSrc = getImageSrcFromElement(el);
              if (imgSrc) {
                const assetId = await extractImageAsset(htmlDir, imgSrc, pageNumber);
                if (assetId) {
                  imgAssetByTagId.set(tagId, assetId);
                  if (!pageAssetIds.includes(assetId)) pageAssetIds.push(assetId);
                }
              }
            }

            const rawOut = translatedSegments[matchingSeg.segId] || matchingSeg.tokenText || '';
            const usedTagIds = new Set<number>();
            let withImages = rawOut.replace(/\[\[V(\d+)\]\]/g, (_m, idStr) => {
              const id = Number.parseInt(idStr, 10);
              const assetId = imgAssetByTagId.get(id);
              if (assetId) {
                usedTagIds.add(id);
                return ` [[PDF_IMG_${assetId}]] `;
              }
              return '';
            });

            for (const [id, assetId] of imgAssetByTagId.entries()) {
              if (!usedTagIds.has(id)) {
                withImages += ` [[PDF_IMG_${assetId}]]`;
              }
            }

            const cleanText = withImages
              .replace(/\[\[(\/?E\d+|V\d+)\]\]/g, '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!cleanText) return;

            const tag = mapDomTagToPdfBlockTag(slot.hostElement);
            if ((tag === 'h1' || tag === 'h2') && chapterTitle === `Phần ${pageNumber}`) {
              chapterTitle = cleanText.replace(/\[\[PDF_IMG_[a-zA-Z0-9_-]+\]\]/g, '').trim() || chapterTitle;
            }
            blocks.push({ tag, html: cleanText });
            return;
          }

          if (slotOwnedNodes.has(node)) {
            return;
          }

          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            const tagUpper = (el.localName || el.tagName || '').toUpperCase();
            if (SKIP_TAGS.has(tagUpper) && tagUpper !== 'SVG') return;

            const standaloneSrc = getImageSrcFromElement(el);
            if (standaloneSrc) {
              const assetId = await extractImageAsset(htmlDir, standaloneSrc, pageNumber);
              if (assetId) {
                if (!pageAssetIds.includes(assetId)) pageAssetIds.push(assetId);
                blocks.push({ tag: 'figure', html: `[[PDF_IMG_${assetId}]]` });
              }
              return;
            }

            const children = Array.from(el.childNodes);
            for (const child of children) {
              await walkDom(child);
            }
          }
        };

        if (rootBody) {
          await walkDom(rootBody);
        }
      } catch {
        // Fallback nếu không parse lại được XHTML gốc
      }
    }

    if (blocks.length === 0 && fileSegs.length > 0) {
      for (const seg of fileSegs) {
        const rawOut = translatedSegments[seg.segId] || seg.tokenText || '';
        const cleanText = rawOut
          .replace(/\[\[(\/?E\d+|V\d+)\]\]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleanText) {
          blocks.push({ tag: 'p', html: cleanText });
        }
      }
    }

    if (blocks.length > 0) {
      const chIndex = chapters.length;
      chapters.push({
        chapterIndex: chIndex,
        title: chapterTitle,
        startPage: pageNumber,
        endPage: pageNumber,
      });
      pages.push({
        pageNumber,
        chapterIndex: chIndex,
        chapterTitle,
        rawDigitalText: blocks.map((b) => b.html).join('\n'),
        requiresVision: false,
        hasFigures: pageAssetIds.length > 0,
        hasTables: false,
        isMultiColumn: false,
        assetIds: pageAssetIds,
        blocks: [],
      });
      translatedPages[pageNumber] = blocks;
    }

    if ((i + 1) % 5 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    parsedPdf: {
      bookTitle: parsed.bookTitle || 'Sách EPUB',
      bookAuthor: parsed.bookAuthor || 'Khuyết danh',
      bookPublisher: parsed.bookPublisher || '',
      totalPages: Math.max(1, pages.length),
      chapters:
        chapters.length > 0
          ? chapters
          : [{ chapterIndex: 0, title: parsed.bookTitle || 'Nội dung', startPage: 1, endPage: 1 }],
      pages,
      assets,
      visionPageCount: 0,
      textOnlyPageCount: pages.length,
    },
    translatedPages,
  };
}

