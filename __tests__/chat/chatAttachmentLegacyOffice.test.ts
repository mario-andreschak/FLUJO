import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { NextRequest } from 'next/server';
import type { ChatAttachmentLimits } from '@/shared/chatAttachments/limits';

const MiB = 1024 * 1024;
const LIMITS: ChatAttachmentLimits = { maxFileBytes: 16 * MiB, maxInlineBytes: 8 * MiB, maxPages: 200, maxTextCharacters: 400_000 };

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: <T,>(handler: T): T => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/chatAttachments/limits', () => ({
  ...jest.requireActual('@/backend/services/chatAttachments/limits'),
  currentChatAttachmentLimits: async () => LIMITS,
}));

import { POST } from '@/app/api/chat/attachments/route';
import { prepareChatAttachment, type PreparedAttachment } from '@/backend/services/chatAttachments/prepare';
import { fileToAttachment } from '@/frontend/components/Chat/attachmentIntake';
import { buildApiContent } from '@/frontend/components/Chat/chatApiContent';

const FIXTURES = path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments');
const fixture = (name: string) => readFile(path.join(FIXTURES, name));

async function prepare(name: string, limits: Partial<ChatAttachmentLimits> = {}, as = name): Promise<PreparedAttachment> {
  return prepareChatAttachment({ bytes: await fixture(name), name: as, limits: { ...LIMITS, ...limits } });
}

function textOf(prepared: PreparedAttachment): string {
  if (prepared.kind !== 'text') throw new Error(`expected text, got ${prepared.kind}: ${JSON.stringify(prepared.note)}`);
  return prepared.text;
}

/** Offset of the first sector that starts with `signature`: where a stream of the compound file begins. */
function streamStart(bytes: Buffer, signature: number[]): number {
  for (let offset = 512; offset < bytes.length; offset += 512) {
    if (signature.every((byte, index) => bytes[offset + index] === byte)) return offset;
  }
  throw new Error('stream not found');
}

const WORD_TEXT = [
  'Seed swap',
  '',
  'Bring seeds in paper envelopes – label each one.',
  'Grüße from the café: 5 € per packet, 番茄 welcome.',
  '',
  'See the club website for dates.',
  '',
  'Seed\tOwner',
  'Bean\tAna',
  'Swap ends at noon.',
  '',
  '## Footnotes',
  'Dry seeds only.',
].join('\n');

const POWERPOINT_TEXT = [
  '## Slide 1',
  'Welcome to the club',
  'Meeting every Tuesday',
  '',
  '## Slide 2',
  'Budget',
  'Seeds: 40 €',
  'Speaker notes: Ask about the compost bin',
].join('\n');

describe('old Office files in chats (#1224)', () => {
  it('reads a Word 97-2003 document: both character widths, a link, a table and a footnote', async () => {
    const prepared = await prepare('legacy.doc');
    expect(prepared.note).toEqual({ code: 'text-extracted', values: { format: 'Word 97-2003 document' } });
    expect(textOf(prepared)).toBe(WORD_TEXT);
  });

  it('reads every sheet of an Excel 97-2003 workbook as CSV, with dates and a shared string longer than one record', async () => {
    const prepared = await prepare('legacy.xls');
    expect(prepared.note).toEqual({ code: 'text-extracted', values: { format: 'Excel 97-2003 workbook' } });
    const text = textOf(prepared);
    expect(text.startsWith([
      '## Sheet: Harvest',
      'Crop,Kilos,Picked',
      'Tomatoes,12.5,2026-01-01',
      '"Beans, green",25,,1',
      'Grüße 番茄,1234567.891,-3',
      '',
      '## Sheet: Notes',
      'Rain expected Friday',
      '',
      '## Sheet: Long',
      'seed seed',
    ].join('\n'))).toBe(true);
    const long = text.slice(text.indexOf('## Sheet: Long\n') + '## Sheet: Long\n'.length);
    expect(long).toBe(`${'seed '.repeat(1800)}end ☀`);
  });

  it('reads PowerPoint 97-2003 slides in order with their speaker notes', async () => {
    const prepared = await prepare('legacy.ppt');
    expect(prepared.note).toEqual({ code: 'text-extracted', values: { format: 'PowerPoint 97-2003 presentation' } });
    expect(textOf(prepared)).toBe(POWERPOINT_TEXT);
  });

  it('keeps to the sheet and character limits and says so', async () => {
    const sheets = await prepare('legacy.xls', { maxPages: 1 });
    expect(sheets.note.shortened).toEqual({ unit: 'sheet', kept: 1, total: 3 });
    expect(textOf(sheets)).not.toContain('Rain expected');
    const slides = await prepare('legacy.ppt', { maxPages: 1 });
    expect(slides.note.shortened).toEqual({ unit: 'slide', kept: 1, total: 2 });
    const characters = await prepare('legacy.doc', { maxTextCharacters: 1000 });
    expect(textOf(characters)).toBe(WORD_TEXT);
    const cut = await prepare('legacy.doc', { maxTextCharacters: 20 } as Partial<ChatAttachmentLimits>);
    expect(cut.note.shortened).toEqual({ unit: 'character', kept: 20 });
    expect(textOf(cut)).toBe('Seed swap\n\nBring see');
  });

  it('goes by what a file contains, not by its name', async () => {
    const workbook = await prepare('legacy.xls', {}, 'budget.doc');
    expect(workbook.note.values).toEqual({ format: 'Excel 97-2003 workbook' });
    const modern = await prepare('sample.docx', {}, 'plan.doc');
    expect(textOf(modern)).toContain('# Garden plan');
    const oldInNewName = await prepare('legacy.doc', {}, 'letter.docx');
    expect(textOf(oldInNewName)).toBe(WORD_TEXT);
    const html = await prepareChatAttachment({ bytes: Buffer.from('<table><tr><td>Plot</td><td>7</td></tr></table>'), name: 'export.xls', limits: LIMITS });
    expect(html).toEqual({ kind: 'text', text: '<table><tr><td>Plot</td><td>7</td></tr></table>', note: { code: 'text' } });
  });

  it('says a file is protected with a password instead of reading nonsense', async () => {
    const word = Buffer.from(await fixture('legacy.doc'));
    word[streamStart(word, [0xec, 0xa5]) + 0x0b] |= 0x01;
    await expect(prepareChatAttachment({ bytes: word, name: 'locked.doc', limits: LIMITS }))
      .resolves.toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'password' } } });

    const workbook = Buffer.from(await fixture('legacy.xls'));
    const bof = streamStart(workbook, [0x09, 0x08]);
    const afterBof = bof + 4 + workbook.readUInt16LE(bof + 2);
    workbook.writeUInt16LE(0x002f, afterBof);
    await expect(prepareChatAttachment({ bytes: workbook, name: 'locked.xls', limits: LIMITS }))
      .resolves.toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'password' } } });

    const slides = Buffer.from(await fixture('legacy.ppt'));
    const token = slides.indexOf(Buffer.from([0x5f, 0xc0, 0x91, 0xe3]));
    expect(token).toBeGreaterThan(0);
    Buffer.from([0xdf, 0xc4, 0xd1, 0xf3]).copy(slides, token);
    await expect(prepareChatAttachment({ bytes: slides, name: 'locked.ppt', limits: LIMITS }))
      .resolves.toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'password' } } });
  });

  it('turns damaged, too old and unknown old Office files into notes', async () => {
    const cut = (await fixture('legacy.doc')).subarray(0, 1536);
    await expect(prepareChatAttachment({ bytes: cut, name: 'cut.doc', limits: LIMITS }))
      .resolves.toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'damaged' } } });

    const word95 = Buffer.from(await fixture('legacy.doc'));
    word95.writeUInt16LE(0x0065 - 1, streamStart(word95, [0xec, 0xa5]) + 2);
    await expect(prepareChatAttachment({ bytes: word95, name: 'old.doc', limits: LIMITS }))
      .resolves.toEqual({ kind: 'note', note: { code: 'legacy-office', values: { format: 'Word 97-2003 document' } } });

    await expect(prepareChatAttachment({ bytes: Buffer.from([0, 1, 2, 3, 0xff, 0xfe]), name: 'budget.xls', limits: LIMITS }))
      .resolves.toEqual({ kind: 'note', note: { code: 'legacy-office', values: { format: 'Excel 97-2003 workbook' } } });
  });

  it('reads old Office files inside a ZIP', async () => {
    const zip = new JSZip();
    zip.file('minutes.doc', await fixture('legacy.doc'));
    zip.file('budget.xls', await fixture('legacy.xls'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const text = textOf(await prepareChatAttachment({ bytes, name: 'club.zip', limits: LIMITS }));
    expect(text).toContain('### minutes.doc (Word 97-2003 document, text extracted)\nSeed swap');
    expect(text).toContain('### budget.xls (Excel 97-2003 workbook, text extracted)\n## Sheet: Harvest');
  });

  describe('from the chat box through the server route', () => {
    const realFetch = global.fetch;
    beforeEach(() => {
      global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(String(input), 'http://localhost'), init);
        return POST(request as unknown as NextRequest);
      }) as typeof fetch;
    });
    afterEach(() => { global.fetch = realFetch; });

    it.each([
      ['legacy.doc', 'Word 97-2003 document', 'Seed swap'],
      ['legacy.xls', 'Excel 97-2003 workbook', 'Tomatoes,12.5,2026-01-01'],
      ['legacy.ppt', 'PowerPoint 97-2003 presentation', 'Speaker notes: Ask about the compost bin'],
    ])('attaches %s as its text and tells the model what it was', async (name, format, sample) => {
      const file = new File([await fixture(name)], name);
      const attachment = await fileToAttachment(file, LIMITS);
      expect(attachment).toMatchObject({ type: 'document', originalName: name, note: { code: 'text-extracted', values: { format } } });
      expect(attachment.content).toContain(sample);
      const wire = buildApiContent({ role: 'user', content: 'What is in it?', attachments: [attachment] } as Parameters<typeof buildApiContent>[0]);
      expect(typeof wire).toBe('string');
      expect(wire).toContain(`[Attached file "${name}" (`);
      expect(wire).toContain(': text extracted]');
      expect(wire).toContain(sample);
      expect(wire).toContain(`[End of "${name}"]`);
    });
  });
});
