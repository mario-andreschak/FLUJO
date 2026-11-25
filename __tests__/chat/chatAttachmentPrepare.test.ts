import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { prepareChatAttachment, type PreparedAttachment } from '@/backend/services/chatAttachments/prepare';
import { walkXml } from '@/backend/services/chatAttachments/textBudget';
import type { ChatAttachmentLimits } from '@/shared/chatAttachments/limits';

const FIXTURES = path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments');
const MiB = 1024 * 1024;
const LIMITS: ChatAttachmentLimits = { maxFileBytes: 16 * MiB, maxInlineBytes: 8 * MiB, maxPages: 200, maxTextCharacters: 400_000 };

async function prepare(name: string, limits: Partial<ChatAttachmentLimits> = {}, mimeType?: string): Promise<PreparedAttachment> {
  const bytes = await readFile(path.join(FIXTURES, name));
  return prepareChatAttachment({ bytes, name, mimeType, limits: { ...LIMITS, ...limits } });
}

function textOf(prepared: PreparedAttachment): string {
  if (prepared.kind !== 'text') throw new Error(`expected text, got ${prepared.kind}: ${JSON.stringify(prepared.note)}`);
  return prepared.text;
}

describe('chat attachment preparation (#1224)', () => {
  it('reads a Word document with headings, lists, tables and line breaks', async () => {
    const prepared = await prepare('sample.docx');
    expect(prepared.note).toEqual({ code: 'text-extracted', values: { format: 'Word document' } });
    const text = textOf(prepared);
    expect(text).toContain('# Garden plan');
    expect(text).toContain('Plant tomatoes after the last frost & water daily.');
    expect(text).toContain('- Basil\n- Chives');
    expect(text).toContain('| Bed | Crop |\n| --- | --- |\n| North | Beans\ttall |');
    expect(text).toContain('Line one\nLine two');
  });

  it('reads every Excel sheet as CSV with dates, booleans and formula results', async () => {
    const text = textOf(await prepare('sample.xlsx'));
    expect(text).toBe([
      '## Sheet: Harvest',
      'Crop,Kilos,Picked',
      'Tomatoes,12.5,2026-01-01',
      '"Beans, green",25,,TRUE',
      '',
      '## Sheet: Notes',
      'Rain expected Friday',
    ].join('\n'));
  });

  it('keeps only the first sheets when a workbook has more than the page limit', async () => {
    const prepared = await prepare('sample.xlsx', { maxPages: 1 });
    expect(prepared.note.shortened).toEqual({ unit: 'sheet', kept: 1, total: 2 });
    expect(textOf(prepared)).not.toContain('Rain expected');
  });

  it('reads PowerPoint slides in presentation order with speaker notes', async () => {
    const text = textOf(await prepare('sample.pptx'));
    expect(text).toBe([
      '## Slide 1',
      'Welcome to the club',
      'Meeting every Tuesday',
      '',
      '## Slide 2',
      'Budget',
      'Seeds: 40 euros',
      'Speaker notes: Ask about the compost bin',
    ].join('\n'));
  });

  it('reads OpenDocument text, spreadsheets and presentations', async () => {
    expect(textOf(await prepare('sample.odt'))).toBe('# Club rules\n\nBring your own gloves.\nShare the tools.\n\n- Close the gate');
    // The file pads rows with 16,000 empty cells and a million empty rows; none of it is expanded.
    expect(textOf(await prepare('sample.ods'))).toBe('## Sheet: Plots\nPlot,Owner\n7,Ana');
    expect(textOf(await prepare('sample.odp'))).toBe('## Slide 1\nHarvest party\n\n## Slide 2\nBring a dish\nSpeaker notes: Remind people twice');
  });

  it('keeps a PDF as a PDF and reports its pages', async () => {
    const prepared = await prepare('sample.pdf');
    expect(prepared).toEqual({ kind: 'pdf', pages: 2, hasText: true, note: { code: 'pdf', values: { pages: 2 } } });
  });

  it('marks a PDF without a text layer so the person knows text-only models cannot see it', async () => {
    const prepared = await prepare('scanned.pdf');
    expect(prepared).toEqual({ kind: 'pdf', pages: 1, hasText: false, note: { code: 'pdf-no-text', values: { pages: 1 } } });
  });

  it('sends the text of a PDF that is too large to send as a file, page by page', async () => {
    const prepared = await prepare('sample.pdf', { maxInlineBytes: 100, maxPages: 1 });
    expect(prepared.note).toEqual({ code: 'pdf-as-text', values: { pages: 2 }, shortened: { unit: 'page', kept: 1, total: 2 } });
    expect(textOf(prepared)).toBe('## Page 1\nQuarterly garden report\nTomatoes did well');
  });

  it('lists a ZIP file and reads the text, code and documents inside', async () => {
    const prepared = await prepare('sample.zip');
    expect(prepared.note).toEqual({ code: 'archive', values: { files: 5 } });
    const text = textOf(prepared);
    expect(text).toContain('Files in this archive (5):');
    for (const name of ['notes.txt', 'data/plots.csv', 'docs/plan.docx', 'photo.png', 'tool.bin']) expect(text).toContain(`- ${name}`);
    expect(text).toContain('### notes.txt\n```\nWater the seedlings.\n```');
    expect(text).toContain('### data/plots.csv\n```csv\nplot,owner\n7,Ana\n\n```');
    expect(text).toContain('### docs/plan.docx (Word document, text extracted)\n# Garden plan');
    expect(text).not.toContain('### photo.png');
  });

  it('opens only as many archive members as the page limit allows', async () => {
    const prepared = await prepare('sample.zip', { maxPages: 1 });
    expect(prepared.note.shortened).toEqual({ unit: 'file', kept: 1, total: 3 });
  });

  it('unpacks a .tar.gz file', async () => {
    const text = textOf(await prepare('sample.tar.gz'));
    expect(text).toContain('Files in this archive (2):');
    expect(text).toContain('### readme.md\n```markdown\n# Seeds\nKeep them dry.\n```');
    expect(text).toContain('### src/app.ts\n```typescript\nexport const plots = 12;\n\n```');
  });

  it.each([
    ['sample.bmp', 'BMP image'],
    ['sample.tiff', 'TIFF image'],
    ['sample.heic', 'HEIC photo'],
    ['sample.svg', 'SVG drawing'],
  ])('converts %s into an image every vision model reads', async (name, format) => {
    const prepared = await prepare(name);
    if (prepared.kind !== 'image') throw new Error(JSON.stringify(prepared));
    expect(prepared.note).toEqual({ code: 'image-converted', values: { format } });
    expect(prepared.mimeType).toBe('image/png');
    const bytes = Buffer.from(prepared.dataUrl.split(',')[1], 'base64');
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeGreaterThan(0);
  });

  it('keeps an iPhone photo this computer cannot convert, for models that read it', async () => {
    // HEVC-coded HEIC needs a decoder sharp does not ship; any unreadable HEIC takes this path.
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32, 7)]);
    const prepared = await prepareChatAttachment({ bytes, name: 'IMG_0042.HEIC', limits: LIMITS });
    expect(prepared).toEqual({
      kind: 'image',
      dataUrl: `data:image/heic;base64,${bytes.toString('base64')}`,
      mimeType: 'image/heic',
      note: { code: 'image-original', values: { format: 'HEIC photo' } },
    });
    const tooBig = await prepareChatAttachment({ bytes, name: 'IMG_0042.HEIC', limits: { ...LIMITS, maxInlineBytes: 10 } });
    expect(tooBig).toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'image' } } });
  });

  it('decodes the colours of a BMP correctly', async () => {
    const prepared = await prepare('sample.bmp');
    if (prepared.kind !== 'image') throw new Error('expected an image');
    const { data } = await sharp(Buffer.from(prepared.dataUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // The file stores rows bottom-up and colours as blue-green-red: the top row is red, green.
    expect([...data.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...data.subarray(3, 6)]).toEqual([0, 255, 0]);
    expect([...data.subarray(6, 9)]).toEqual([0, 0, 255]);
  });

  it('shrinks an image that is too large to send', async () => {
    const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer();
    const prepared = await prepareChatAttachment({ bytes: big, name: 'noise.png', limits: { ...LIMITS, maxInlineBytes: 200_000 } });
    if (prepared.kind !== 'image') throw new Error(JSON.stringify(prepared));
    expect(prepared.note.code).toBe('image-reduced');
    expect(Buffer.from(prepared.dataUrl.split(',')[1], 'base64').length).toBeLessThanOrEqual(200_000);
  });

  it('cuts long text at the character limit and says so', async () => {
    const prepared = await prepare('sample.docx', { maxTextCharacters: 20 });
    expect(prepared.note.shortened).toEqual({ unit: 'character', kept: 20 });
    expect(textOf(prepared).length).toBeLessThanOrEqual(20);
  });

  it('turns unreadable files into notes instead of errors', async () => {
    expect(await prepare('sample.bin')).toEqual({ kind: 'note', note: { code: 'name-only' } });
    const legacy = await prepareChatAttachment({ bytes: Buffer.from('old'), name: 'budget.xls', limits: LIMITS });
    expect(legacy).toEqual({ kind: 'note', note: { code: 'legacy-office', values: { format: 'Excel 97-2003 workbook' } } });
    const broken = await prepareChatAttachment({ bytes: Buffer.from('not a zip'), name: 'broken.docx', limits: LIMITS });
    expect(broken).toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'damaged' } } });
    const brokenPdf = await prepareChatAttachment({ bytes: Buffer.from('%PDF-1.4 nonsense'), name: 'broken.pdf', limits: LIMITS });
    expect(brokenPdf).toEqual({ kind: 'note', note: { code: 'failed', values: { reason: 'damaged' } } });
  });

  it('never unpacks more than the part limit from a tiny compressed archive member', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${'a'.repeat(40 * MiB)}</w:t></w:r></w:p></w:body></w:document>`);
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bomb.length).toBeLessThan(MiB);
    const prepared = await prepareChatAttachment({ bytes: bomb, name: 'bomb.docx', limits: { ...LIMITS, maxTextCharacters: 1000 } });
    expect(prepared.note.shortened).toEqual({ unit: 'character', kept: 1000 });
  });

  it('gives other requests a turn while walking a large XML part', async () => {
    const xml = `<r>${'<c>x</c>'.repeat(50_000)}</r>`;
    let otherWorkRan = false;
    setImmediate(() => { otherWorkRan = true; });
    let sawOtherWorkMidWalk = false;
    let tokens = 0;
    await walkXml(xml, () => {
      tokens++;
      if (tokens === 140_000) sawOtherWorkMidWalk = otherWorkRan;
    });
    expect(sawOtherWorkMidWalk).toBe(true);
  });
});
