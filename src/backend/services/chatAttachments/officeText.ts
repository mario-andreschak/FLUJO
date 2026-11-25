import type JSZip from 'jszip';
import type { AttachmentShortenedUnit } from '@/shared/chatAttachments/limits';
import { TextBudget, walkXml, type XmlToken } from './textBudget';
import { readRelationships, readZipText } from './zipEntries';

/**
 * Text from Word, Excel, PowerPoint and OpenDocument files (#1224). These are
 * ZIP folders of XML; only the parts a reader would see are kept: paragraphs,
 * headings, lists, tables, cell values, slide text and speaker notes.
 */
export interface ExtractLimits {
  maxPages: number;
  maxTextCharacters: number;
  /** Largest unpacked XML part read from the archive. */
  maxPartBytes: number;
}

export interface ExtractedText {
  text: string;
  shortened?: { unit: AttachmentShortenedUnit; kept: number; total?: number };
  /** Pages, slides or sheets in the file, when known. */
  units?: number;
}

export type OfficeKind = 'word' | 'excel' | 'powerpoint' | 'odf-text' | 'odf-sheet' | 'odf-slides';

const KIND_BY_EXTENSION: Record<string, OfficeKind> = {
  docx: 'word', docm: 'word', dotx: 'word',
  xlsx: 'excel', xlsm: 'excel', xltx: 'excel',
  pptx: 'powerpoint', pptm: 'powerpoint', ppsx: 'powerpoint', potx: 'powerpoint',
  odt: 'odf-text', ods: 'odf-sheet', odp: 'odf-slides',
};

const ODF_KIND_BY_MIME: Record<string, OfficeKind> = {
  'application/vnd.oasis.opendocument.text': 'odf-text',
  'application/vnd.oasis.opendocument.spreadsheet': 'odf-sheet',
  'application/vnd.oasis.opendocument.presentation': 'odf-slides',
};

/** The document kind from the file's own contents, falling back to its extension. */
export async function detectOfficeKind(zip: JSZip, extension: string): Promise<OfficeKind | undefined> {
  if (zip.file('word/document.xml')) return 'word';
  if (zip.file('xl/workbook.xml')) return 'excel';
  if (zip.file('ppt/presentation.xml')) return 'powerpoint';
  const mimetype = (await zip.file('mimetype')?.async('string'))?.trim();
  if (mimetype && ODF_KIND_BY_MIME[mimetype]) return ODF_KIND_BY_MIME[mimetype];
  return zip.file('content.xml') ? KIND_BY_EXTENSION[extension] : undefined;
}

export async function extractOfficeText(zip: JSZip, kind: OfficeKind, limits: ExtractLimits): Promise<ExtractedText> {
  switch (kind) {
    case 'word': return wordText(zip, limits);
    case 'excel': return excelText(zip, limits);
    case 'powerpoint': return powerPointText(zip, limits);
    case 'odf-text': return odfText(zip, limits);
    case 'odf-sheet': return odfSheetText(zip, limits);
    case 'odf-slides': return odfSlidesText(zip, limits);
  }
}

function cellText(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

export function markdownTable(rows: string[][]): string {
  const filled = rows.filter(row => row.some(cell => cell.trim()));
  if (filled.length === 0) return '';
  const width = Math.max(...filled.map(row => row.length));
  const cells = filled.map(row => Array.from({ length: width }, (_, index) => cellText(row[index] ?? '')));
  const [head, ...body] = cells;
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(cells: string[]): string {
  let end = cells.length;
  while (end > 0 && !cells[end - 1]) end--;
  return cells.slice(0, end).map(cell => csvCell(cell ?? '')).join(',');
}

function shortenedByCharacters(budget: TextBudget): ExtractedText['shortened'] {
  return budget.full ? { unit: 'character', kept: budget.used } : undefined;
}

/** Track nested tables: paragraphs inside a cell join that cell instead of the page. */
class TableStack {
  private readonly tables: string[][][] = [];
  private readonly cells: string[][] = [];

  get active(): boolean {
    return this.tables.length > 0;
  }

  openTable(): void { this.tables.push([]); }
  openRow(): void { this.tables.at(-1)?.push([]); }
  openCell(): void { this.cells.push([]); }
  addToCell(text: string): void { this.cells.at(-1)?.push(text); }

  closeCell(): void {
    const cell = this.cells.pop();
    this.tables.at(-1)?.at(-1)?.push((cell ?? []).join(' ').trim());
  }

  /** Returns the finished table when it was the outermost one. */
  closeTable(): string | undefined {
    const rows = this.tables.pop();
    const table = markdownTable(rows ?? []);
    if (this.tables.length > 0) {
      if (table) this.addToCell(table.replace(/\n/g, ' '));
      return undefined;
    }
    return table;
  }
}

const HEADING_STYLE = /^(?:heading|berschrift|titre|titolo|t[ií]tulo|ttulo|kop|rubrik|nagwek)\s*(\d)$/i;

async function officeDocumentPart(zip: JSZip, fallback: string, limits: ExtractLimits): Promise<string> {
  const rels = await readRelationships(zip, '', limits.maxPartBytes, (xml, visit) =>
    walkXml(xml, token => { if (token.kind === 'open' && token.name === 'Relationship') visit(token.attrs); }));
  for (const rel of rels.values()) {
    if (rel.type.endsWith('/officeDocument')) return rel.target;
  }
  return fallback;
}

async function wordText(zip: JSZip, limits: ExtractLimits): Promise<ExtractedText> {
  const part = await officeDocumentPart(zip, 'word/document.xml', limits);
  const xml = await readZipText(zip, part, limits.maxPartBytes) ?? '';
  const budget = new TextBudget(limits.maxTextCharacters);
  const tables = new TableStack();
  let paragraph: string[] | undefined;
  let heading = 0;
  let listItem = false;
  let inText = 0;
  let skip = 0;

  const emit = (text: string) => budget.push(text);
  await walkXml(xml, token => {
    if (token.kind === 'open') {
      switch (token.name) {
        case 'p': paragraph = []; heading = 0; listItem = false; break;
        case 'pStyle': {
          const style = token.attrs.val ?? '';
          const match = HEADING_STYLE.exec(style);
          if (match) heading = Math.min(6, Number(match[1]));
          else if (/^title$/i.test(style)) heading = 1;
          break;
        }
        case 'outlineLvl': heading = Math.min(6, Number(token.attrs.val ?? 0) + 1); break;
        case 'numPr': listItem = true; break;
        case 't': inText++; break;
        case 'delText': case 'instrText': skip++; break;
        case 'tab': paragraph?.push('\t'); break;
        case 'br': case 'cr': paragraph?.push('\n'); break;
        case 'tbl': tables.openTable(); break;
        case 'tr': tables.openRow(); break;
        case 'tc': tables.openCell(); break;
      }
      return true;
    }
    if (token.kind === 'close') {
      switch (token.name) {
        case 't': inText = Math.max(0, inText - 1); break;
        case 'delText': case 'instrText': skip = Math.max(0, skip - 1); break;
        case 'p': {
          const text = (paragraph ?? []).join('').replace(/[ \t]+\n/g, '\n').trim();
          paragraph = undefined;
          if (!text) break;
          if (tables.active) tables.addToCell(text);
          else if (heading) return emit(`${'#'.repeat(heading)} ${text}\n\n`);
          else if (listItem) return emit(`- ${text}\n`);
          else return emit(`${text}\n\n`);
          break;
        }
        case 'tc': tables.closeCell(); break;
        case 'tbl': {
          const table = tables.closeTable();
          if (table) return emit(`\n${table}\n\n`);
          break;
        }
      }
      return true;
    }
    if (inText && !skip && paragraph) paragraph.push(token.text);
    return true;
  });
  // A part cut off at the size cap ends inside a paragraph; keep what was read.
  const unfinished = (paragraph ?? []).join('').trim();
  if (unfinished) emit(unfinished);
  return { text: budget.toString(), shortened: shortenedByCharacters(budget) };
}

interface ExcelStyles {
  dateStyles: Set<number>;
}

const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code: string): boolean {
  const visible = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(visible) && !/^general$/i.test(visible.trim());
}

async function excelStyles(zip: JSZip, limits: ExtractLimits): Promise<ExcelStyles> {
  const xml = await readZipText(zip, 'xl/styles.xml', limits.maxPartBytes);
  const dateStyles = new Set<number>();
  if (!xml) return { dateStyles };
  const customDates = new Set<number>();
  let inCellXfs = false;
  let index = 0;
  await walkXml(xml, token => {
    if (token.kind === 'open' && token.name === 'numFmt' && isDateFormatCode(token.attrs.formatCode ?? '')) {
      customDates.add(Number(token.attrs.numFmtId));
    } else if (token.kind === 'open' && token.name === 'cellXfs') {
      inCellXfs = true;
    } else if (token.kind === 'close' && token.name === 'cellXfs') {
      inCellXfs = false;
    } else if (inCellXfs && token.kind === 'open' && token.name === 'xf') {
      const formatId = Number(token.attrs.numFmtId ?? 0);
      if (BUILT_IN_DATE_FORMATS.has(formatId) || customDates.has(formatId)) dateStyles.add(index);
      index++;
    }
  });
  return { dateStyles };
}

async function sharedStrings(zip: JSZip, limits: ExtractLimits): Promise<string[]> {
  const xml = await readZipText(zip, 'xl/sharedStrings.xml', limits.maxPartBytes);
  const strings: string[] = [];
  if (!xml) return strings;
  let current: string[] | undefined;
  let inText = false;
  let phonetic = 0;
  await walkXml(xml, token => {
    if (token.kind === 'open') {
      if (token.name === 'si') current = [];
      else if (token.name === 'rPh') phonetic++;
      else if (token.name === 't') inText = true;
    } else if (token.kind === 'close') {
      if (token.name === 'si') { strings.push((current ?? []).join('')); current = undefined; }
      else if (token.name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (token.name === 't') inText = false;
    } else if (inText && !phonetic && current) {
      current.push(token.text);
    }
  });
  return strings;
}

export function excelDate(serial: number, date1904: boolean): string {
  const days = serial + (date1904 ? 1462 : 0);
  const time = new Date(Math.round((days - 25569) * 86_400_000));
  if (Number.isNaN(time.getTime())) return String(serial);
  const iso = time.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function columnIndex(reference: string | undefined, fallback: number): number {
  const letters = /^([A-Z]+)/i.exec(reference ?? '')?.[1];
  if (!letters) return fallback;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

async function excelText(zip: JSZip, limits: ExtractLimits): Promise<ExtractedText> {
  const workbookPart = await officeDocumentPart(zip, 'xl/workbook.xml', limits);
  const workbookXml = await readZipText(zip, workbookPart, limits.maxPartBytes) ?? '';
  const sheets: Array<{ name: string; relationship: string }> = [];
  let date1904 = false;
  await walkXml(workbookXml, token => {
    if (token.kind !== 'open') return;
    if (token.name === 'sheet') sheets.push({ name: token.attrs.name ?? `Sheet ${sheets.length + 1}`, relationship: token.attrs.id ?? '' });
    if (token.name === 'workbookPr' && /^(1|true)$/i.test(token.attrs.date1904 ?? '')) date1904 = true;
  });
  const relationships = await readRelationships(zip, workbookPart, limits.maxPartBytes, (xml, visit) =>
    walkXml(xml, token => { if (token.kind === 'open' && token.name === 'Relationship') visit(token.attrs); }));
  const strings = await sharedStrings(zip, limits);
  const styles = await excelStyles(zip, limits);
  const budget = new TextBudget(limits.maxTextCharacters);
  const kept = sheets.slice(0, limits.maxPages);

  for (const sheet of kept) {
    const path = relationships.get(sheet.relationship)?.target;
    const xml = path ? await readZipText(zip, path, limits.maxPartBytes) : undefined;
    if (!budget.push(`## Sheet: ${sheet.name}\n`)) break;
    if (!xml) continue;
    let row: string[] | undefined;
    let cell: { column: number; type: string; style: number; value: string[]; inline: string[] } | undefined;
    let inValue = false;
    let inInline = false;
    let wroteRow = false;
    await walkXml(xml, token => {
      if (token.kind === 'open') {
        if (token.name === 'row') row = [];
        else if (token.name === 'c' && row) {
          cell = {
            column: columnIndex(token.attrs.r, row.length),
            type: token.attrs.t ?? 'n',
            style: Number(token.attrs.s ?? 0),
            value: [],
            inline: [],
          };
        } else if (token.name === 'v') inValue = true;
        else if (token.name === 't' && cell?.type === 'inlineStr') inInline = true;
        return true;
      }
      if (token.kind === 'close') {
        if (token.name === 'v') inValue = false;
        else if (token.name === 't') inInline = false;
        else if (token.name === 'c' && cell && row) {
          const raw = cell.value.join('');
          let value = raw;
          if (cell.type === 's') value = strings[Number(raw)] ?? '';
          else if (cell.type === 'inlineStr') value = cell.inline.join('');
          else if (cell.type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (cell.type === 'n' && raw && styles.dateStyles.has(cell.style) && Number.isFinite(Number(raw))) {
            value = excelDate(Number(raw), date1904);
          }
          if (cell.column < 16_384) row[cell.column] = value;
          cell = undefined;
        } else if (token.name === 'row' && row) {
          const line = csvLine(Array.from(row, value => value ?? ''));
          row = undefined;
          if (line) {
            wroteRow = true;
            return budget.push(`${line}\n`);
          }
        }
        return true;
      }
      if (inValue && cell) cell.value.push(token.text);
      else if (inInline && cell) cell.inline.push(token.text);
      return true;
    });
    if (!wroteRow && !budget.push('(empty)\n')) break;
    if (!budget.push('\n')) break;
  }
  return {
    text: budget.toString(),
    units: sheets.length,
    shortened: kept.length < sheets.length
      ? { unit: 'sheet', kept: kept.length, total: sheets.length }
      : shortenedByCharacters(budget),
  };
}

/** Paragraph text of DrawingML shapes (slides and notes). */
async function drawingParagraphs(xml: string): Promise<string[]> {
  const paragraphs: string[] = [];
  let current: string[] | undefined;
  let inText = false;
  await walkXml(xml, token => {
    if (token.kind === 'open') {
      if (token.name === 'p') current = [];
      else if (token.name === 't') inText = true;
      else if (token.name === 'br') current?.push('\n');
    } else if (token.kind === 'close') {
      if (token.name === 't') inText = false;
      else if (token.name === 'p') {
        const text = (current ?? []).join('').trim();
        if (text) paragraphs.push(text);
        current = undefined;
      }
    } else if (inText && current) {
      current.push(token.text);
    }
  });
  return paragraphs;
}

async function powerPointText(zip: JSZip, limits: ExtractLimits): Promise<ExtractedText> {
  const presentation = await officeDocumentPart(zip, 'ppt/presentation.xml', limits);
  const presentationXml = await readZipText(zip, presentation, limits.maxPartBytes) ?? '';
  const relationships = await readRelationships(zip, presentation, limits.maxPartBytes, (xml, visit) =>
    walkXml(xml, token => { if (token.kind === 'open' && token.name === 'Relationship') visit(token.attrs); }));
  const ordered: string[] = [];
  await walkXml(presentationXml, token => {
    if (token.kind === 'open' && token.name === 'sldId') {
      const target = relationships.get(token.attrs.id ?? '')?.target;
      if (target) ordered.push(target);
    }
  });
  const slides = ordered.length > 0 ? ordered : Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));

  const budget = new TextBudget(limits.maxTextCharacters);
  const kept = slides.slice(0, limits.maxPages);
  for (const [index, slide] of kept.entries()) {
    const xml = await readZipText(zip, slide, limits.maxPartBytes) ?? '';
    const lines = await drawingParagraphs(xml);
    const slideRels = await readRelationships(zip, slide, limits.maxPartBytes, (relsXml, visit) =>
      walkXml(relsXml, token => { if (token.kind === 'open' && token.name === 'Relationship') visit(token.attrs); }));
    const notesPart = [...slideRels.values()].find(rel => rel.type.endsWith('/notesSlide'))?.target;
    const notesXml = notesPart ? await readZipText(zip, notesPart, limits.maxPartBytes) : undefined;
    const notes = notesXml ? (await drawingParagraphs(notesXml)).filter(line => !/^\d+$/.test(line)) : [];
    const block = [`## Slide ${index + 1}`, ...lines, ...(notes.length ? [`Speaker notes: ${notes.join(' ')}`] : [])];
    if (!budget.push(`${block.join('\n')}\n\n`)) break;
  }
  return {
    text: budget.toString(),
    units: slides.length,
    shortened: kept.length < slides.length
      ? { unit: 'slide', kept: kept.length, total: slides.length }
      : shortenedByCharacters(budget),
  };
}

/** OpenDocument paragraph text, honouring spaces, tabs and line breaks. */
function odfInline(token: XmlToken, paragraph: string[] | undefined): void {
  if (token.kind !== 'open' || !paragraph) return;
  if (token.name === 's') paragraph.push(' '.repeat(Math.min(100, Math.max(1, Number(token.attrs.c ?? 1)))));
  else if (token.name === 'tab') paragraph.push('\t');
  else if (token.name === 'line-break') paragraph.push('\n');
}

const ODF_SKIPPED = new Set(['annotation', 'tracked-changes', 'note-citation']);

async function odfContent(zip: JSZip, limits: ExtractLimits): Promise<string> {
  return await readZipText(zip, 'content.xml', limits.maxPartBytes) ?? '';
}

async function odfText(zip: JSZip, limits: ExtractLimits): Promise<ExtractedText> {
  const xml = await odfContent(zip, limits);
  const budget = new TextBudget(limits.maxTextCharacters);
  const tables = new TableStack();
  const paragraphs: Array<{ parts: string[]; heading: number }> = [];
  let listDepth = 0;
  let skip = 0;
  await walkXml(xml, token => {
    if (token.kind === 'open') {
      if (ODF_SKIPPED.has(token.name)) skip++;
      else if (token.name === 'p' || token.name === 'h') {
        paragraphs.push({ parts: [], heading: token.name === 'h' ? Math.min(6, Math.max(1, Number(token.attrs['outline-level'] ?? 1))) : 0 });
      } else if (token.name === 'list-item') listDepth++;
      else if (token.name === 'table' && !token.selfClosing) tables.openTable();
      else if (token.name === 'table-row') tables.openRow();
      else if (token.name === 'table-cell') tables.openCell();
      else odfInline(token, paragraphs.at(-1)?.parts);
      return true;
    }
    if (token.kind === 'close') {
      if (ODF_SKIPPED.has(token.name)) skip = Math.max(0, skip - 1);
      else if (token.name === 'list-item') listDepth = Math.max(0, listDepth - 1);
      else if (token.name === 'table-cell') tables.closeCell();
      else if (token.name === 'table') {
        const table = tables.closeTable();
        if (table) return budget.push(`\n${table}\n\n`);
      } else if (token.name === 'p' || token.name === 'h') {
        const paragraph = paragraphs.pop();
        const text = (paragraph?.parts ?? []).join('').trim();
        if (!text) return true;
        if (paragraphs.length > 0) { paragraphs.at(-1)?.parts.push(text); return true; }
        if (tables.active) { tables.addToCell(text); return true; }
        if (paragraph?.heading) return budget.push(`${'#'.repeat(paragraph.heading)} ${text}\n\n`);
        return budget.push(listDepth > 0 ? `- ${text}\n` : `${text}\n\n`);
      }
      return true;
    }
    if (!skip) paragraphs.at(-1)?.parts.push(token.text);
    return true;
  });
  return { text: budget.toString(), shortened: shortenedByCharacters(budget) };
}

function odfCellValue(attrs: Record<string, string>): string | undefined {
  switch (attrs['value-type']) {
    case 'float': case 'percentage': case 'currency': return attrs.value;
    case 'date': return attrs['date-value'];
    case 'time': return attrs['time-value'];
    case 'boolean': return attrs['boolean-value'] === 'true' ? 'TRUE' : 'FALSE';
    default: return undefined;
  }
}

async function odfSheetText(zip: JSZip, limits: ExtractLimits): Promise<ExtractedText> {
  const xml = await odfContent(zip, limits);
  const budget = new TextBudget(limits.maxTextCharacters);
  let sheets = 0;
  // Sheets pad rows with thousands of repeated empty cells. Empty cells only
  // become real once a later cell in the row has content.
  let row: { cells: string[]; pendingEmpty: number } | undefined;
  let rowRepeat = 1;
  let cell: { repeat: number; value?: string; parts: string[] } | undefined;
  let paragraphDepth = 0;
  let skip = 0;
  let skippingSheet = false;
  await walkXml(xml, token => {
    if (token.kind === 'open') {
      if (ODF_SKIPPED.has(token.name)) skip++;
      else if (token.name === 'table' && !token.selfClosing) {
        sheets++;
        skippingSheet = sheets > limits.maxPages;
        if (!skippingSheet) return budget.push(`## Sheet: ${token.attrs.name ?? `Sheet ${sheets}`}\n`);
      } else if (skippingSheet) return true;
      else if (token.name === 'table-row') {
        row = { cells: [], pendingEmpty: 0 };
        rowRepeat = Math.max(1, Number(token.attrs['number-rows-repeated'] ?? 1));
      } else if (token.name === 'table-cell' || token.name === 'covered-table-cell') {
        cell = { repeat: Math.max(1, Number(token.attrs['number-columns-repeated'] ?? 1)), value: odfCellValue(token.attrs), parts: [] };
      } else if (token.name === 'p') {
        if (paragraphDepth++ > 0 || (cell?.parts.length ?? 0) > 0) cell?.parts.push('\n');
      } else odfInline(token, cell?.parts);
      return true;
    }
    if (token.kind === 'close') {
      if (ODF_SKIPPED.has(token.name)) skip = Math.max(0, skip - 1);
      else if (skippingSheet && token.name !== 'table') return true;
      else if (token.name === 'p') paragraphDepth = Math.max(0, paragraphDepth - 1);
      else if ((token.name === 'table-cell' || token.name === 'covered-table-cell') && cell && row) {
        const value = cell.value ?? cell.parts.join('').trim();
        if (!value) row.pendingEmpty += cell.repeat;
        else {
          const room = 16_384 - row.cells.length;
          const gap = Math.min(row.pendingEmpty, room);
          for (let index = 0; index < gap; index++) row.cells.push('');
          row.pendingEmpty = 0;
          for (let copy = 0; copy < Math.min(cell.repeat, 1024) && row.cells.length < 16_384; copy++) row.cells.push(value);
        }
        cell = undefined;
      } else if (token.name === 'table-row' && row) {
        const line = csvLine(row.cells);
        row = undefined;
        if (line) {
          for (let copy = 0; copy < Math.min(rowRepeat, 1024); copy++) {
            if (!budget.push(`${line}\n`)) return false;
          }
        }
      } else if (token.name === 'table') {
        skippingSheet = false;
        return budget.push('\n');
      }
      return true;
    }
    if (!skip && cell && !skippingSheet) cell.parts.push(token.text);
    return true;
  });
  const kept = Math.min(sheets, limits.maxPages);
  return {
    text: budget.toString(),
    units: sheets,
    shortened: kept < sheets ? { unit: 'sheet', kept, total: sheets } : shortenedByCharacters(budget),
  };
}

async function odfSlidesText(zip: JSZip, limits: ExtractLimits): Promise<ExtractedText> {
  const xml = await odfContent(zip, limits);
  const budget = new TextBudget(limits.maxTextCharacters);
  let pages = 0;
  let lines: string[] = [];
  let notes: string[] = [];
  let paragraph: string[] | undefined;
  let inNotes = 0;
  const flush = () => {
    if (pages > limits.maxPages) return true;
    const block = [`## Slide ${pages}`, ...lines, ...(notes.length ? [`Speaker notes: ${notes.join(' ')}`] : [])];
    lines = [];
    notes = [];
    return budget.push(`${block.join('\n')}\n\n`);
  };
  await walkXml(xml, token => {
    if (token.kind === 'open') {
      if (token.name === 'page') pages++;
      else if (token.name === 'notes') inNotes++;
      else if (token.name === 'p' || token.name === 'h') paragraph = [];
      else odfInline(token, paragraph);
      return true;
    }
    if (token.kind === 'close') {
      if (token.name === 'notes') inNotes = Math.max(0, inNotes - 1);
      else if ((token.name === 'p' || token.name === 'h') && paragraph) {
        const text = paragraph.join('').trim();
        paragraph = undefined;
        if (text) (inNotes ? notes : lines).push(text);
      } else if (token.name === 'page') return flush();
      return true;
    }
    paragraph?.push(token.text);
    return true;
  });
  const kept = Math.min(pages, limits.maxPages);
  return {
    text: budget.toString(),
    units: pages,
    shortened: kept < pages ? { unit: 'slide', kept, total: pages } : shortenedByCharacters(budget),
  };
}
