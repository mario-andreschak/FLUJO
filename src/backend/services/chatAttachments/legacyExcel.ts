import { CompoundFile, LegacyOfficeError } from './compoundFile';
import { csvLine, excelDate, isDateFormat, shortenedByCharacters, type ExtractedText, type ExtractLimits } from './officeText';
import { TextBudget, yieldToEventLoop } from './textBudget';

/**
 * Text of an Excel 97-2003 workbook (.xls, BIFF8; Excel 5/95 BIFF5 too):
 * every worksheet as CSV, with shared strings, numbers, dates, booleans and
 * the last calculated result of each formula, like the .xlsx reader.
 */
const RECORD = {
  BOF: 0x0809, EOF: 0x000a, FILEPASS: 0x002f, CODEPAGE: 0x0042, DATEMODE: 0x0022, FORMAT: 0x041e, XF: 0x00e0,
  BOUNDSHEET: 0x0085, SST: 0x00fc, CONTINUE: 0x003c, LABELSST: 0x00fd, LABEL: 0x0204, RSTRING: 0x00d6,
  NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd, BOOLERR: 0x0205, FORMULA: 0x0006, STRING: 0x0207,
} as const;
const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };
const MAX_COLUMNS = 256;
const LATIN1 = new TextDecoder('latin1');
const UTF16 = new TextDecoder('utf-16le');

interface BiffRecord { type: number; data: Uint8Array }

function* records(stream: Uint8Array, start: number): Generator<BiffRecord> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let offset = start; offset + 4 <= stream.length;) {
    const type = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (offset + 4 + size > stream.length) return;
    yield { type, data: stream.subarray(offset + 4, offset + 4 + size) };
    offset += 4 + size;
  }
}

const u16 = (data: Uint8Array, at: number) => data[at] | (data[at + 1] << 8);
const u32 = (data: Uint8Array, at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16)) + data[at + 3] * 0x1000000;

function decodeChars(bytes: Uint8Array, wide: boolean, codepage: TextDecoder): string {
  return (wide ? UTF16 : codepage).decode(bytes);
}

/**
 * Reads strings that may run on into CONTINUE records. Where characters are
 * split, the next record starts with a byte saying whether the rest is one or
 * two bytes per character.
 */
class ContinuedReader {
  private chunk = 0;
  private position = 0;

  constructor(private readonly chunks: Uint8Array[]) {}

  private settle(): void {
    while (this.chunk < this.chunks.length && this.position >= this.chunks[this.chunk].length) {
      this.chunk++;
      this.position = 0;
    }
  }

  get done(): boolean {
    this.settle();
    return this.chunk >= this.chunks.length;
  }

  byte(): number {
    this.settle();
    if (this.done) throw new LegacyOfficeError('damaged', 'The shared string table is cut short');
    return this.chunks[this.chunk][this.position++];
  }

  word(): number { return this.byte() | (this.byte() << 8); }
  long(): number { return (this.word() | (this.word() << 16)) >>> 0; }

  skip(count: number): void {
    for (let left = count; left > 0;) {
      this.settle();
      if (this.done) return;
      const step = Math.min(left, this.chunks[this.chunk].length - this.position);
      this.position += step;
      left -= step;
    }
  }

  characters(count: number, wide: boolean): string {
    const parts: string[] = [];
    for (let left = count; left > 0;) {
      let current = this.chunks[this.chunk];
      if (!current || this.position >= current.length) {
        this.chunk++;
        this.position = 0;
        current = this.chunks[this.chunk];
        if (!current || current.length === 0) break;
        wide = (current[this.position++] & 0x01) === 1;
      }
      const width = wide ? 2 : 1;
      const take = Math.min(left, Math.floor((current.length - this.position) / width));
      if (take === 0) { this.position = current.length; continue; }
      parts.push(decodeChars(current.subarray(this.position, this.position + take * width), wide, LATIN1));
      this.position += take * width;
      left -= take;
    }
    return parts.join('');
  }
}

async function sharedStrings(chunks: Uint8Array[]): Promise<string[]> {
  const reader = new ContinuedReader(chunks);
  reader.skip(4);
  const unique = reader.long();
  const strings: string[] = [];
  while (strings.length < unique && !reader.done) {
    const count = reader.word();
    const flags = reader.byte();
    const runs = flags & 0x08 ? reader.word() : 0;
    const extra = flags & 0x04 ? reader.long() : 0;
    strings.push(reader.characters(count, (flags & 0x01) === 1));
    reader.skip(runs * 4 + extra);
    if (strings.length % 5000 === 0) await yieldToEventLoop();
  }
  return strings;
}

interface Workbook {
  biff8: boolean;
  codepage: TextDecoder;
  date1904: boolean;
  formats: Map<number, string>;
  cellFormats: number[];
  strings: string[];
  sheets: Array<{ name: string; offset: number }>;
}

const CODEPAGES: Record<number, string> = { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh' };

/** BIFF8 short strings (`count` already read): a flag byte, then 8- or 16-bit characters. */
function unicodeString(data: Uint8Array, at: number, count: number, workbook: Pick<Workbook, 'biff8' | 'codepage'>): string {
  if (!workbook.biff8) return decodeChars(data.subarray(at, at + count), false, workbook.codepage);
  const wide = (data[at] & 0x01) === 1;
  return decodeChars(data.subarray(at + 1, at + 1 + count * (wide ? 2 : 1)), wide, LATIN1);
}

async function readWorkbook(stream: Uint8Array): Promise<Workbook> {
  const workbook: Workbook = {
    biff8: true, codepage: new TextDecoder('windows-1252'), date1904: false,
    formats: new Map(), cellFormats: [], strings: [], sheets: [],
  };
  let sst: Uint8Array[] | undefined;
  let first = true;
  for (const record of records(stream, 0)) {
    if (first) {
      first = false;
      if (record.type !== RECORD.BOF) throw new LegacyOfficeError('unsupported', 'Excel files older than Excel 5 are not read');
      workbook.biff8 = u16(record.data, 0) === 0x0600;
      continue;
    }
    if (sst && record.type === RECORD.CONTINUE) { sst.push(record.data); continue; }
    if (sst) { workbook.strings = await sharedStrings(sst); sst = undefined; }
    switch (record.type) {
      case RECORD.FILEPASS: throw new LegacyOfficeError('password', 'The workbook is protected with a password');
      case RECORD.CODEPAGE: {
        const label = CODEPAGES[u16(record.data, 0)];
        if (label) workbook.codepage = new TextDecoder(label);
        break;
      }
      case RECORD.DATEMODE: workbook.date1904 = u16(record.data, 0) === 1; break;
      case RECORD.FORMAT: {
        const index = u16(record.data, 0);
        const format = workbook.biff8
          ? unicodeString(record.data, 4, u16(record.data, 2), workbook)
          : decodeChars(record.data.subarray(3, 3 + record.data[2]), false, workbook.codepage);
        workbook.formats.set(index, format);
        break;
      }
      case RECORD.XF: workbook.cellFormats.push(u16(record.data, 2)); break;
      case RECORD.BOUNDSHEET: {
        if (record.data[5] !== 0) break;
        const count = record.data[6];
        const name = workbook.biff8
          ? unicodeString(record.data, 7, count, workbook)
          : decodeChars(record.data.subarray(7, 7 + count), false, workbook.codepage);
        workbook.sheets.push({ name, offset: u32(record.data, 0) });
        break;
      }
      case RECORD.SST: sst = [record.data]; break;
      case RECORD.EOF: return workbook;
    }
  }
  if (sst) workbook.strings = await sharedStrings(sst);
  return workbook;
}

function rkNumber(rk: number): number {
  let value: number;
  if (rk & 0x02) value = (rk | 0) >> 2;
  else {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, rk & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }
  return rk & 0x01 ? value / 100 : value;
}

function numberText(value: number, cellFormat: number, workbook: Workbook): string {
  const format = workbook.cellFormats[cellFormat];
  if (format !== undefined && isDateFormat(format, workbook.formats.get(format))) return excelDate(value, workbook.date1904);
  return String(Number(value.toPrecision(15)));
}

function float(data: Uint8Array, at: number): number {
  return new DataView(data.buffer, data.byteOffset + at, 8).getFloat64(0, true);
}

/** Rows of one worksheet, keeping roughly `maxCharacters` of cell text. */
async function sheetRows(stream: Uint8Array, offset: number, workbook: Workbook, maxCharacters: number): Promise<{ rows: Map<number, string[]>; cut: boolean }> {
  const rows = new Map<number, string[]>();
  let characters = 0;
  let depth = 0;
  let pendingFormula: { row: number; column: number } | undefined;
  let seen = 0;
  const put = (row: number, column: number, value: string) => {
    if (column >= MAX_COLUMNS || !value) return;
    let cells = rows.get(row);
    if (!cells) rows.set(row, cells = []);
    cells[column] = value;
    characters += value.length + 1;
  };
  for (const record of records(stream, offset)) {
    if (++seen % 20_000 === 0) await yieldToEventLoop();
    if (characters > maxCharacters) return { rows, cut: true };
    const { data } = record;
    switch (record.type) {
      case RECORD.BOF: depth++; continue;
      case RECORD.EOF: if (--depth <= 0) return { rows, cut: false }; continue;
    }
    if (depth !== 1) continue;
    const row = u16(data, 0);
    const column = u16(data, 2);
    switch (record.type) {
      case RECORD.LABELSST: put(row, column, workbook.strings[u32(data, 6)] ?? ''); break;
      case RECORD.LABEL:
      case RECORD.RSTRING: put(row, column, unicodeString(data, 8, u16(data, 6), workbook)); break;
      case RECORD.NUMBER: put(row, column, numberText(float(data, 6), u16(data, 4), workbook)); break;
      case RECORD.RK: put(row, column, numberText(rkNumber(u32(data, 6)), u16(data, 4), workbook)); break;
      case RECORD.MULRK:
        for (let at = 4, index = 0; at + 6 <= data.length - 2; at += 6, index++) {
          put(row, column + index, numberText(rkNumber(u32(data, at + 2)), u16(data, at), workbook));
        }
        break;
      case RECORD.BOOLERR:
        put(row, column, data[7] ? ERRORS[data[6]] ?? '#ERROR' : data[6] ? 'TRUE' : 'FALSE');
        break;
      case RECORD.FORMULA:
        pendingFormula = undefined;
        if (u16(data, 12) !== 0xffff) put(row, column, numberText(float(data, 6), u16(data, 4), workbook));
        else if (data[6] === 0) pendingFormula = { row, column };
        else if (data[6] === 1) put(row, column, data[8] ? 'TRUE' : 'FALSE');
        else if (data[6] === 2) put(row, column, ERRORS[data[8]] ?? '#ERROR');
        break;
      case RECORD.STRING:
        if (pendingFormula) put(pendingFormula.row, pendingFormula.column, unicodeString(data, 2, u16(data, 0), workbook));
        pendingFormula = undefined;
        break;
    }
  }
  return { rows, cut: false };
}

export async function legacyExcelText(file: CompoundFile, limits: ExtractLimits): Promise<ExtractedText> {
  const stream = file.stream('Workbook', limits.maxPartBytes) ?? file.stream('Book', limits.maxPartBytes);
  if (!stream) throw new LegacyOfficeError('damaged', 'The workbook stream is missing');
  const workbook = await readWorkbook(stream);
  const budget = new TextBudget(limits.maxTextCharacters);
  const kept = workbook.sheets.slice(0, limits.maxPages);
  for (const sheet of kept) {
    if (!budget.push(`## Sheet: ${sheet.name}\n`)) break;
    const { rows } = await sheetRows(stream, sheet.offset, workbook, limits.maxTextCharacters - budget.used);
    const lines = [...rows.keys()].sort((a, b) => a - b)
      .map(row => csvLine(Array.from(rows.get(row) ?? [], value => value ?? '')))
      .filter(Boolean);
    if (!budget.push(lines.length ? `${lines.join('\n')}\n\n` : '(empty)\n\n')) break;
    await yieldToEventLoop();
  }
  return {
    text: budget.toString(),
    units: workbook.sheets.length,
    shortened: kept.length < workbook.sheets.length
      ? { unit: 'sheet', kept: kept.length, total: workbook.sheets.length }
      : shortenedByCharacters(budget),
  };
}
