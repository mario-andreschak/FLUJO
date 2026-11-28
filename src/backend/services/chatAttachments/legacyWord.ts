import { CompoundFile, LegacyOfficeError } from './compoundFile';
import type { ExtractedText, ExtractLimits } from './officeText';
import { TextBudget, yieldToEventLoop } from './textBudget';

/**
 * Text of a Word 97-2003 document (.doc, MS-DOC): the piece table in the
 * table stream says where each run of characters lives in the WordDocument
 * stream and whether it is stored as one byte (Windows-1252) or two (UTF-16).
 * Body text comes first, then footnotes, comments, endnotes and text boxes.
 */
interface Piece {
  cpStart: number;
  cpEnd: number;
  byteStart: number;
  compressed: boolean;
}

const FC_CLX_INDEX = 33;
const WINDOWS_1252 = new TextDecoder('windows-1252');
const UTF16 = new TextDecoder('utf-16le');

function pieceTable(table: Uint8Array, fcClx: number, lcbClx: number): Piece[] {
  if (fcClx + lcbClx > table.length || lcbClx === 0) throw new LegacyOfficeError('damaged', 'The Word piece table is missing');
  const view = new DataView(table.buffer, table.byteOffset + fcClx, lcbClx);
  let offset = 0;
  while (offset < lcbClx && view.getUint8(offset) === 0x01) {
    offset += 3 + view.getInt16(offset + 1, true);
  }
  if (offset + 5 > lcbClx || view.getUint8(offset) !== 0x02) throw new LegacyOfficeError('damaged', 'The Word piece table is damaged');
  const size = view.getUint32(offset + 1, true);
  const start = offset + 5;
  if (start + size > lcbClx) throw new LegacyOfficeError('damaged', 'The Word piece table is cut short');
  const count = Math.floor((size - 4) / 12);
  const pieces: Piece[] = [];
  for (let index = 0; index < count; index++) {
    const cpStart = view.getUint32(start + index * 4, true);
    const cpEnd = view.getUint32(start + (index + 1) * 4, true);
    const fc = view.getUint32(start + (count + 1) * 4 + index * 8 + 2, true);
    const compressed = (fc & 0x40000000) !== 0;
    const raw = fc & 0x3fffffff;
    if (cpEnd > cpStart) pieces.push({ cpStart, cpEnd, compressed, byteStart: compressed ? raw / 2 : raw });
  }
  return pieces;
}

/** Characters [from, to) of the document, at most `maxCharacters` of them. */
async function characters(word: Uint8Array, pieces: Piece[], from: number, to: number, maxCharacters: number): Promise<string> {
  const parts: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    const start = Math.max(from, piece.cpStart);
    const end = Math.min(to, piece.cpEnd, start + maxCharacters - length);
    if (end <= start) continue;
    const width = piece.compressed ? 1 : 2;
    const byteStart = piece.byteStart + (start - piece.cpStart) * width;
    const byteEnd = byteStart + (end - start) * width;
    if (byteEnd > word.length) throw new LegacyOfficeError('damaged', 'Word text lies outside the file');
    const bytes = word.subarray(byteStart, byteEnd);
    parts.push((piece.compressed ? WINDOWS_1252 : UTF16).decode(bytes));
    length += end - start;
    if (length >= maxCharacters) break;
    await yieldToEventLoop();
  }
  return parts.join('');
}

/**
 * Word's control characters as plain text: paragraph marks become blank
 * lines, table cells tabs and rows lines; of a field (a link, a page number)
 * only its shown result is kept.
 */
export function wordPlainText(raw: string): string {
  let out = '';
  const fields: boolean[] = [];
  let hiddenDepth = 0;
  let previous = '';
  for (const char of raw) {
    switch (char) {
      case '\x13': fields.push(true); hiddenDepth++; continue;
      case '\x14': if (fields.at(-1)) { fields[fields.length - 1] = false; hiddenDepth--; } continue;
      case '\x15': if (fields.pop()) hiddenDepth--; continue;
    }
    if (hiddenDepth > 0) continue;
    switch (char) {
      case '\r': out += '\n\n'; break;
      case '\x07': out += previous === '\x07' ? '\n' : '\t'; break;
      case '\x0b': case '\x0e': out += '\n'; break;
      case '\x0c': out += '\n\n'; break;
      case '\x1e': out += '-'; break;
      case '\xa0': out += ' '; break;
      default:
        if (char === '\t' || char.charCodeAt(0) >= 0x20) out += char;
    }
    previous = char;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function legacyWordText(file: CompoundFile, limits: ExtractLimits): Promise<ExtractedText> {
  const word = file.stream('WordDocument', limits.maxPartBytes);
  if (!word || word.length < 0x22) throw new LegacyOfficeError('damaged', 'The WordDocument stream is missing');
  const view = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (view.getUint16(0, true) !== 0xa5ec) throw new LegacyOfficeError('damaged', 'Not a Word document');
  if (view.getUint16(2, true) < 101) throw new LegacyOfficeError('unsupported', 'Word 6 and Word 95 files are not read');
  const flags = view.getUint16(0x0a, true);
  if (flags & 0x0100) throw new LegacyOfficeError('password', 'The Word document is protected with a password');
  const table = file.stream(flags & 0x0200 ? '1Table' : '0Table', limits.maxPartBytes);
  if (!table) throw new LegacyOfficeError('damaged', 'The Word table stream is missing');

  let offset = 32;
  offset += 2 + view.getUint16(offset, true) * 2;
  const longCount = view.getUint16(offset, true);
  const longs = offset + 2;
  const counter = (index: number) => (index < longCount ? Math.max(0, view.getInt32(longs + index * 4, true)) : 0);
  offset = longs + longCount * 4;
  const pairCount = view.getUint16(offset, true);
  if (pairCount <= FC_CLX_INDEX || offset + 2 + (FC_CLX_INDEX + 1) * 8 > word.length) {
    throw new LegacyOfficeError('damaged', 'The Word file header is cut short');
  }
  const clx = offset + 2 + FC_CLX_INDEX * 8;
  const pieces = pieceTable(table, view.getUint32(clx, true), view.getUint32(clx + 4, true));

  const [body, footnotes, headers, , comments, endnotes, textBoxes] = [3, 4, 5, 6, 7, 8, 9].map(counter);
  const sections: Array<{ title?: string; length: number }> = [
    { length: body },
    { title: 'Footnotes', length: footnotes },
    { length: headers },
    { title: 'Comments', length: comments },
    { title: 'Endnotes', length: endnotes },
    { title: 'Text boxes', length: textBoxes },
  ];
  const budget = new TextBudget(limits.maxTextCharacters);
  // Control characters and field codes shrink when cleaned, so read a little more than the budget.
  const readLimit = limits.maxTextCharacters * 2 + 1024;
  let cp = 0;
  for (const section of sections) {
    const from = cp;
    cp += section.length;
    if (!section.title && section !== sections[0]) continue;
    const text = wordPlainText(await characters(word, pieces, from, cp, readLimit));
    if (!text) continue;
    if (!budget.push(section.title ? `\n\n## ${section.title}\n${text}` : text)) break;
  }
  return { text: budget.toString(), shortened: budget.full ? { unit: 'character', kept: budget.used } : undefined };
}
