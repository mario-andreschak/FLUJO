import { CompoundFile, LegacyOfficeError } from './compoundFile';
import { shortenedByCharacters, type ExtractedText, type ExtractLimits } from './officeText';
import { TextBudget, yieldToEventLoop } from './textBudget';

/**
 * Text of a PowerPoint 97-2003 presentation (.ppt, MS-PPT): slides in show
 * order with their speaker notes. The "Current User" stream points at the
 * latest edit, whose persist directory says where each slide is stored; the
 * slide list holds slide text, and slides drawn without it keep their text in
 * their own drawing records. A file whose directory cannot be followed is read
 * slide by slide in file order instead.
 */
const TYPE = {
  DOCUMENT: 1000, SLIDE: 1006, SLIDE_ATOM: 1007, NOTES: 1008, SLIDE_PERSIST: 1011, TEXT_CHARS: 4000, TEXT_BYTES: 4008,
  SLIDE_LIST: 4080, USER_EDIT: 4085, PERSIST_DIRECTORY: 6002,
} as const;
const ENCRYPTED_TOKEN = 0xf3d1c4df;
const MAX_DEPTH = 32;
const LATIN1 = new TextDecoder('latin1');
const UTF16 = new TextDecoder('utf-16le');

interface PptRecord { type: number; instance: number; container: boolean; start: number; end: number }

class PowerPointStream {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(at: number): number {
    return at >= 0 && at + 4 <= this.bytes.length ? this.view.getUint32(at, true) : 0;
  }

  record(at: number): PptRecord | undefined {
    if (at < 0 || at + 8 > this.bytes.length) return undefined;
    const versionAndInstance = this.view.getUint16(at, true);
    const end = at + 8 + this.view.getUint32(at + 4, true);
    if (end > this.bytes.length) return undefined;
    return { type: this.view.getUint16(at + 2, true), instance: versionAndInstance >> 4, container: (versionAndInstance & 0x0f) === 0x0f, start: at + 8, end };
  }

  *children(parent: Pick<PptRecord, 'start' | 'end'>): Generator<PptRecord> {
    for (let at = parent.start; at + 8 <= parent.end;) {
      const record = this.record(at);
      if (!record || record.end > parent.end) return;
      yield record;
      at = record.end;
    }
  }

  text(record: PptRecord): string {
    const bytes = this.bytes.subarray(record.start, record.end);
    const raw = record.type === TYPE.TEXT_CHARS ? UTF16.decode(bytes) : LATIN1.decode(bytes);
    return raw.replace(/[\r\x0b]/g, '\n').replace(/[\x00-\x08\x0c\x0e-\x1f]/g, '').trim();
  }

  /** Every text atom under a record, in order. */
  texts(parent: PptRecord, depth = 0): string[] {
    if (depth > MAX_DEPTH) return [];
    const found: string[] = [];
    for (const child of this.children(parent)) {
      if (child.type === TYPE.TEXT_CHARS || child.type === TYPE.TEXT_BYTES) {
        const text = this.text(child);
        if (text) found.push(text);
      } else if (child.container) found.push(...this.texts(child, depth + 1));
    }
    return found;
  }
}

/** Persist id → stream offset, oldest edit first so later edits win. */
function persistDirectory(ppt: PowerPointStream, currentUser: Uint8Array | undefined): { offsets: Map<number, number>; documentId: number } | undefined {
  if (!currentUser || currentUser.length < 20) return undefined;
  const user = new DataView(currentUser.buffer, currentUser.byteOffset, currentUser.byteLength);
  if (user.getUint32(12, true) === ENCRYPTED_TOKEN) throw new LegacyOfficeError('password', 'The presentation is protected with a password');
  const directories: number[] = [];
  const seen = new Set<number>();
  let documentId: number | undefined;
  for (let at = user.getUint32(16, true); !seen.has(at);) {
    seen.add(at);
    const edit = ppt.record(at);
    if (!edit || edit.type !== TYPE.USER_EDIT) break;
    if (edit.end - edit.start >= 0x20 && ppt.u32(edit.start + 0x1c) !== 0) {
      throw new LegacyOfficeError('password', 'The presentation is protected with a password');
    }
    documentId ??= ppt.u32(edit.start + 16);
    directories.push(ppt.u32(edit.start + 12));
    const previous = ppt.u32(edit.start + 8);
    if (previous === 0) break;
    at = previous;
  }
  if (documentId === undefined) return undefined;
  const offsets = new Map<number, number>();
  for (const at of directories.reverse()) {
    const directory = ppt.record(at);
    if (!directory || directory.type !== TYPE.PERSIST_DIRECTORY) continue;
    for (let position = directory.start; position + 4 <= directory.end;) {
      const entry = ppt.u32(position);
      const first = entry & 0xfffff;
      const count = entry >>> 20;
      position += 4;
      for (let index = 0; index < count && position + 4 <= directory.end; index++, position += 4) {
        offsets.set(first + index, ppt.u32(position));
      }
    }
  }
  return { offsets, documentId };
}

interface ListedSlide { persistId: number; slideId: number; texts: string[] }

function slideList(ppt: PowerPointStream, document: PptRecord, instance: number): ListedSlide[] {
  const slides: ListedSlide[] = [];
  for (const list of ppt.children(document)) {
    if (list.type !== TYPE.SLIDE_LIST || list.instance !== instance) continue;
    for (const child of ppt.children(list)) {
      if (child.type === TYPE.SLIDE_PERSIST) {
        slides.push({ persistId: ppt.u32(child.start), slideId: ppt.u32(child.start + 12), texts: [] });
      } else if ((child.type === TYPE.TEXT_CHARS || child.type === TYPE.TEXT_BYTES) && slides.length) {
        const text = ppt.text(child);
        if (text) slides[slides.length - 1].texts.push(text);
      }
    }
  }
  return slides;
}

interface SlideText { lines: string[]; notes: string[] }

function slidesFromDirectory(ppt: PowerPointStream, currentUser: Uint8Array | undefined): SlideText[] | undefined {
  const directory = persistDirectory(ppt, currentUser);
  const documentAt = directory?.offsets.get(directory.documentId);
  const document = documentAt === undefined ? undefined : ppt.record(documentAt);
  if (!directory || !document || document.type !== TYPE.DOCUMENT) return undefined;
  const container = (persistId: number, type: number) => {
    const at = directory.offsets.get(persistId);
    const record = at === undefined ? undefined : ppt.record(at);
    return record?.type === type ? record : undefined;
  };
  const notesBySlideId = new Map(slideList(ppt, document, 2).map(notes => [notes.slideId, notes]));
  return slideList(ppt, document, 0).map(listed => {
    const slide = container(listed.persistId, TYPE.SLIDE);
    const lines = listed.texts.length || !slide ? listed.texts : ppt.texts(slide);
    const atom = slide ? [...ppt.children(slide)].find(child => child.type === TYPE.SLIDE_ATOM) : undefined;
    const listedNotes = atom ? notesBySlideId.get(ppt.u32(atom.start + 16)) : undefined;
    const notesContainer = listedNotes ? container(listedNotes.persistId, TYPE.NOTES) : undefined;
    const notes = listedNotes?.texts.length ? listedNotes.texts : notesContainer ? ppt.texts(notesContainer) : [];
    return { lines, notes };
  });
}

function slidesInFileOrder(ppt: PowerPointStream): SlideText[] {
  const slides: SlideText[] = [];
  for (const record of ppt.children({ start: 0, end: ppt.bytes.length })) {
    if (record.type === TYPE.SLIDE) slides.push({ lines: ppt.texts(record), notes: [] });
  }
  return slides;
}

export async function legacyPowerPointText(file: CompoundFile, limits: ExtractLimits): Promise<ExtractedText> {
  if (file.has('EncryptedSummary')) throw new LegacyOfficeError('password', 'The presentation is protected with a password');
  const stream = file.stream('PowerPoint Document', limits.maxPartBytes);
  if (!stream) throw new LegacyOfficeError('damaged', 'The PowerPoint Document stream is missing');
  const ppt = new PowerPointStream(stream);
  const slides = slidesFromDirectory(ppt, file.stream('Current User', 64 * 1024)) ?? slidesInFileOrder(ppt);
  const budget = new TextBudget(limits.maxTextCharacters);
  const kept = slides.slice(0, limits.maxPages);
  for (const [index, slide] of kept.entries()) {
    const block = [`## Slide ${index + 1}`, ...slide.lines, ...(slide.notes.length ? [`Speaker notes: ${slide.notes.join(' ')}`] : [])];
    if (!budget.push(`${block.join('\n')}\n\n`)) break;
    if (index % 50 === 49) await yieldToEventLoop();
  }
  return {
    text: budget.toString(),
    units: slides.length,
    shortened: kept.length < slides.length
      ? { unit: 'slide', kept: kept.length, total: slides.length }
      : shortenedByCharacters(budget),
  };
}
