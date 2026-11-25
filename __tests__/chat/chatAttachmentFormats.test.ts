import { classifyAttachment, fenceFor, looksLikeText } from '@/shared/chatAttachments/formats';
import {
  defaultMaxFileBytes,
  inlineBytesForRunInputLimit,
  normalizeChatAttachmentSettings,
  resolveChatAttachmentLimits,
} from '@/shared/chatAttachments/limits';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('chat attachment formats (#1224)', () => {
  it.each([
    ['notes.md', '', 'text', 'markdown'],
    // Windows reports TypeScript files as MPEG transport streams.
    ['app.ts', 'video/mp2t', 'text', 'typescript'],
    ['report.ABAP', '', 'text', 'abap'],
    ['Dockerfile', '', 'text', 'dockerfile'],
    ['photo.jpg', 'image/jpeg', 'image', undefined],
    ['IMG_0001.HEIC', '', 'image-convert', undefined],
    ['scan.pdf', '', 'pdf', undefined],
    ['plan.docx', '', 'document', undefined],
    ['numbers.xlsm', '', 'document', undefined],
    ['deck.odp', '', 'document', undefined],
    ['code.tar.gz', 'application/gzip', 'archive', undefined],
    ['memo.webm', 'audio/webm', 'audio', undefined],
    ['clip.webm', 'video/webm', 'video', undefined],
    ['old.doc', 'application/msword', 'legacy-office', undefined],
    ['blob', 'application/x-unknown', 'binary', undefined],
    ['data', 'application/json', 'text', undefined],
    ['screen', 'image/png', 'image', undefined],
  ])('classifies %s (%s) as %s', (name, mime, family, language) => {
    const result = classifyAttachment(name, mime);
    expect(result.family).toBe(family);
    expect(result.language).toBe(language);
  });

  it('tells text from binary bytes', () => {
    expect(looksLikeText(new TextEncoder().encode('plain text, with ümlauts\n'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(false);
  });

  it('picks a code fence the content cannot close', () => {
    expect(fenceFor('no fences')).toBe('```');
    expect(fenceFor('has ```js\ncode\n``` inside')).toBe('````');
  });
});

describe('chat attachment limits (#1224)', () => {
  it('scales the default file limit with the computer memory, within bounds', () => {
    expect(defaultMaxFileBytes(4 * GiB)).toBe(16 * MiB);
    expect(defaultMaxFileBytes(16 * GiB)).toBe(32 * MiB);
    expect(defaultMaxFileBytes(64 * GiB)).toBe(64 * MiB);
    expect(defaultMaxFileBytes(Number.NaN)).toBe(16 * MiB);
  });

  it('derives the inline limit from the run input limit', () => {
    expect(inlineBytesForRunInputLimit(64 * MiB)).toBe(Math.floor(64 * MiB / 6));
    expect(inlineBytesForRunInputLimit(1)).toBe(MiB);
  });

  it('uses saved settings over defaults and clamps them into range', () => {
    const machine = { defaultMaxFileBytes: 64 * MiB, maxInlineBytes: 10 * MiB };
    expect(resolveChatAttachmentLimits(undefined, machine)).toEqual({
      maxFileBytes: 64 * MiB, maxInlineBytes: 10 * MiB, maxPages: 200, maxTextCharacters: 400_000,
    });
    expect(resolveChatAttachmentLimits({ maxFileMegabytes: 4, maxPages: 10, maxTextCharacters: 5000 }, machine)).toEqual({
      maxFileBytes: 4 * MiB, maxInlineBytes: 4 * MiB, maxPages: 10, maxTextCharacters: 5000,
    });
    expect(normalizeChatAttachmentSettings({ maxFileMegabytes: 5000, maxPages: 0, maxTextCharacters: Number.NaN })).toEqual({
      maxFileMegabytes: 96, maxPages: 1,
    });
  });
});
