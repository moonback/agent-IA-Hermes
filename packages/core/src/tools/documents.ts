import { inflateRawSync } from 'node:zlib';
import { HermesError, errorMessage } from '../shared/errors';

/**
 * Text extraction from office documents for files.read: PDF (pdf.js), DOCX (mammoth → Markdown)
 * and XLSX (built-in reader: zip + SpreadsheetML). Bounded to keep the model context reasonable.
 */

export const DOCUMENT_LIMITS = {
  /** Pages read from a PDF. */
  maxPages: 100,
  /** Characters of extracted text (≈ 500 KB). */
  maxChars: 500_000,
  /** Size of the document file itself. */
  maxFileBytes: 50 * 1024 * 1024,
  /** Uncompressed size of one zip entry (zip-bomb guard). */
  maxEntryBytes: 64 * 1024 * 1024,
  maxRowsPerSheet: 5_000,
} as const;

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx';
export const DOCUMENT_EXTENSIONS: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
};

export type CellValue = string | number | boolean | null;

export interface ExtractedDocument {
  format: DocumentFormat;
  text: string;
  truncated: boolean;
  /** PDF: total pages, and how many were read. */
  pages: number | null;
  pagesRead: number | null;
  metadata: Record<string, string | null>;
  sheets: { name: string; rows: CellValue[][]; truncated: boolean }[] | null;
  warnings: string[];
}

const cap = (text: string, limit: number = DOCUMENT_LIMITS.maxChars) =>
  text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };

// ------------------------------------------------------------------ zip

/** Minimal zip reader (central directory, stored/deflated entries). Refuses encryption and ZIP64. */
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new HermesError('VALIDATION', 'Archive ZIP invalide (répertoire central introuvable)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || count === 0xffff)
    throw new HermesError('VALIDATION', 'Archive ZIP64 non prise en charge');
  const entries = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new HermesError('VALIDATION', 'Archive ZIP corrompue');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new HermesError('VALIDATION', 'Document chiffré ou protégé par mot de passe');
    if (usize > DOCUMENT_LIMITS.maxEntryBytes)
      throw new HermesError('VALIDATION', `Élément ${name} trop volumineux une fois décompressé`);
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50)
        throw new HermesError('VALIDATION', 'Archive ZIP corrompue');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method !== 8)
        throw new HermesError('VALIDATION', `Méthode de compression ${method} non prise en charge`);
      // maxOutputLength bounds the real output even if the declared size lies.
      return inflateRawSync(data, { maxOutputLength: DOCUMENT_LIMITS.maxEntryBytes });
    });
  }
  return entries;
}

// ------------------------------------------------------------------ xml helpers (regular OOXML only)

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : null;
};

/** Concatenated text of every <t> element (rich-text runs included). */
const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join('');

// ------------------------------------------------------------------ xlsx

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date (1900 system) → ISO date (time kept when present). */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function resolveTarget(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

export function extractXlsx(buf: Buffer): ExtractedDocument {
  const zip = readZip(buf);
  const read = (name: string) => zip.get(name)?.().toString('utf8') ?? null;
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new HermesError('VALIDATION', 'Classeur XLSX invalide (xl/workbook.xml absent)');
  const rels = new Map(
    [...(read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attr(m[0], 'Id') ?? '',
      attr(m[0], 'Target') ?? '',
    ]),
  );
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    textOf(m[1]!),
  );
  const stylesXml = read('xl/styles.xml') ?? '';
  const customDate = new Set(
    [...stylesXml.matchAll(/<numFmt\b[^>]*>/g)]
      .filter((m) => /[dmyh]/i.test((attr(m[0], 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '')))
      .map((m) => Number(attr(m[0], 'numFmtId'))),
  );
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || customDate.has(id);
  });

  const sheets: NonNullable<ExtractedDocument['sheets']> = [];
  const warnings: string[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], 'name') ?? `Feuille ${sheets.length + 1}`;
    const target = rels.get(attr(m[0], 'r:id') ?? '');
    const xml = target ? read(resolveTarget(target)) : null;
    if (!xml) {
      warnings.push(`Feuille « ${name} » introuvable dans l’archive`);
      continue;
    }
    const rows: CellValue[][] = [];
    let truncated = false;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= DOCUMENT_LIMITS.maxRowsPerSheet) {
        truncated = true;
        break;
      }
      const r = Number(attr(row[0], 'r') ?? rows.length + 1) - 1;
      const cells: CellValue[] = [];
      for (const c of row[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${c[1]}>`;
        const inner = c[2] ?? '';
        const type = attr(tag, 't');
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value: CellValue = null;
        if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? null;
        else if (type === 'inlineStr') value = textOf(inner);
        else if (type === 'str') value = raw === undefined ? null : decodeXml(raw);
        else if (type === 'b') value = raw === '1';
        else if (type === 'e') value = raw === undefined ? null : `#${decodeXml(raw)}`;
        else if (raw !== undefined) {
          const num = Number(raw);
          value = dateStyle[Number(attr(tag, 's') ?? 0)] && Number.isFinite(num) ? excelDate(num) : num;
        }
        cells[colIndex(attr(tag, 'r') ?? 'A')] = value;
      }
      while (rows.length < r) rows.push([]);
      rows.push(Array.from(cells, (v) => (v === undefined ? null : v)));
    }
    sheets.push({ name, rows, truncated });
  }
  const text = sheets
    .map(
      (s) =>
        `## Feuille : ${s.name}\n${s.rows.map((r) => r.map((v) => (v === null ? '' : String(v))).join('\t')).join('\n')}`,
    )
    .join('\n\n');
  const capped = cap(text);
  return {
    format: 'xlsx',
    ...capped,
    truncated: capped.truncated || sheets.some((s) => s.truncated),
    pages: null,
    pagesRead: null,
    metadata: coreProperties(zip),
    sheets,
    warnings,
  };
}

/** docProps/core.xml (title, author, dates) shared by DOCX and XLSX. */
function coreProperties(zip: Map<string, () => Buffer>): Record<string, string | null> {
  const xml = zip.get('docProps/core.xml')?.().toString('utf8') ?? '';
  const get = (tag: string) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m ? decodeXml(m[1]!) : null;
  };
  return {
    title: get('dc:title'),
    author: get('dc:creator'),
    created: get('dcterms:created'),
    modified: get('dcterms:modified'),
  };
}

// ------------------------------------------------------------------ docx

interface Mammoth {
  convertToHtml(input: {
    buffer: Buffer;
  }): Promise<{ value: string; messages: { type: string; message: string }[] }>;
}

/**
 * Markdown from the small, regular HTML mammoth emits (h1-h6, p, strong/em, ul/ol/li, a, br,
 * table/tr/th/td). mammoth's own Markdown output drops tables, which matter in reports.
 */
export function mammothHtmlToMarkdown(html: string): string {
  const inline = (s: string) =>
    decodeXml(
      s
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, '**$2**')
        .replace(/<(em|i)>([\s\S]*?)<\/\1>/g, '_$2_')
        .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
        .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/g, '[image : $1]')
        .replace(/<[^>]+>/g, ''),
    ).trim();
  const cell = (s: string) => inline(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  let md = html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_m, body: string) => {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => cell(c[1]!)),
    );
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
    return `\n\n${[line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
  });
  md = md
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g,
      (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${inline(t)}\n\n`,
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/g, (_m, t: string) => `\n- ${inline(t)}`)
    .replace(/<\/?(ul|ol)\b[^>]*>/g, '\n')
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/g, (_m, t: string) => `\n\n${inline(t)}\n\n`);
  return md
    .split('\n')
    .map((l) => (l.startsWith('|') || l.startsWith('- ') || l.startsWith('#') ? l : inline(l)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocx(buf: Buffer): Promise<ExtractedDocument> {
  const zip = readZip(buf); // validates the archive (encryption, bombs) before mammoth sees it
  if (!zip.has('word/document.xml'))
    throw new HermesError('VALIDATION', 'Document DOCX invalide (word/document.xml absent)');
  const mammoth = (await import('mammoth')) as unknown as Mammoth & { default?: Mammoth };
  const m = mammoth.default ?? mammoth;
  const r = await m.convertToHtml({ buffer: buf });
  const capped = cap(mammothHtmlToMarkdown(r.value));
  return {
    format: 'docx',
    ...capped,
    pages: null,
    pagesRead: null,
    metadata: coreProperties(zip),
    sheets: null,
    warnings: r.messages.filter((x) => x.type === 'error').map((x) => x.message.slice(0, 200)),
  };
}

// ------------------------------------------------------------------ pdf

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfJs {
  getDocument(src: Record<string, unknown>): {
    destroy(): Promise<void>;
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }>; cleanup(): void }>;
      getMetadata(): Promise<{ info?: Record<string, unknown> }>;
    }>;
  };
}

export async function extractPdf(buf: Buffer): Promise<ExtractedDocument> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
  let doc: Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  // Kept to release the document and its worker, whatever happens.
  let task: ReturnType<PdfJs['getDocument']> | null = null;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      // Never compile font programs into JavaScript (CVE-2024-4367); text extraction does not need it.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (err) {
    await task?.destroy().catch(() => undefined);
    const msg = errorMessage(err);
    throw new HermesError(
      'VALIDATION',
      /password/i.test(msg) ? 'PDF protégé par mot de passe' : `PDF illisible : ${msg.slice(0, 200)}`,
    );
  }
  try {
    const pagesRead = Math.min(doc.numPages, DOCUMENT_LIMITS.maxPages);
    const parts: string[] = [];
    let chars = 0;
    let read = 0;
    for (let n = 1; n <= pagesRead && chars < DOCUMENT_LIMITS.maxChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
      page.cleanup();
      parts.push(`--- Page ${n} ---\n${text}`);
      chars += text.length;
      read = n;
    }
    const info: Record<string, unknown> = (await doc.getMetadata().catch(() => ({ info: {} }))).info ?? {};
    const s = (k: string) => (typeof info[k] === 'string' && info[k] ? (info[k] as string) : null);
    const capped = cap(parts.join('\n\n'));
    const warnings: string[] = [];
    if (doc.numPages > DOCUMENT_LIMITS.maxPages)
      warnings.push(
        `Seules les ${DOCUMENT_LIMITS.maxPages} premières pages sur ${doc.numPages} ont été lues`,
      );
    if (!capped.text.replace(/--- Page \d+ ---/g, '').trim())
      warnings.push(
        'Aucun texte extractible : document probablement numérisé (image), une reconnaissance de caractères serait nécessaire',
      );
    return {
      format: 'pdf',
      ...capped,
      truncated: capped.truncated || read < doc.numPages,
      pages: doc.numPages,
      pagesRead: read,
      metadata: {
        title: s('Title'),
        author: s('Author'),
        producer: s('Producer'),
        created: s('CreationDate'),
      },
      sheets: null,
      warnings,
    };
  } finally {
    await task.destroy();
  }
}

export async function extractDocument(buf: Buffer, format: DocumentFormat): Promise<ExtractedDocument> {
  if (buf.length > DOCUMENT_LIMITS.maxFileBytes)
    throw new HermesError(
      'VALIDATION',
      `Document trop volumineux (> ${DOCUMENT_LIMITS.maxFileBytes / 1024 / 1024} Mo)`,
    );
  if (format === 'pdf') return extractPdf(buf);
  if (format === 'docx') return extractDocx(buf);
  return extractXlsx(buf);
}
