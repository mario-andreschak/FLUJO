import { buildApiContent, type Attachment, type ChatMessage } from '@/frontend/components/Chat/chatApiContent';

const message = (content: string, attachments: Attachment[]): ChatMessage => ({
  id: 'message',
  role: 'user',
  content,
  timestamp: 1,
  attachments,
});

describe('what the model reads about chat attachments (#1224)', () => {
  it('labels text files and wraps them in a fence the content cannot break', () => {
    const content = buildApiContent(message('Review this', [{
      id: 'a',
      type: 'document',
      content: 'const a = 1;\n```\nnot a fence end',
      originalName: 'app.ts',
      size: 2048,
      format: 'TypeScript',
      language: 'typescript',
      note: { code: 'text' },
    }]));
    expect(content).toBe([
      'Review this',
      '',
      '[Attached file "app.ts" (TypeScript, 2 KB)]',
      '````typescript',
      'const a = 1;',
      '```',
      'not a fence end',
      '````',
    ].join('\n'));
  });

  it('marks where extracted document text ends and says when it was shortened', () => {
    const content = buildApiContent(message('', [{
      id: 'a',
      type: 'document',
      content: '## Slide 1\nHello',
      originalName: 'deck.pptx',
      format: 'PowerPoint presentation',
      note: { code: 'text-extracted', values: { format: 'PowerPoint presentation' }, shortened: { unit: 'slide', kept: 1, total: 3 } },
    }]));
    expect(content).toBe(
      '[Attached file "deck.pptx" (PowerPoint presentation): text extracted; only the first 1 of 3 slides were read]\n'
      + '## Slide 1\nHello\n[End of "deck.pptx"]',
    );
  });

  it('tells the model about files that could not be sent instead of leaving them out', () => {
    const content = buildApiContent(message('See attached', [
      { id: 'a', type: 'document', content: '', originalName: 'tool.bin', size: 7, format: 'File', note: { code: 'name-only' } },
      { id: 'b', type: 'document', content: '', originalName: 'huge.mov', format: 'QuickTime video', note: { code: 'too-large', values: { limit: 64 * 1024 * 1024 } } },
      { id: 'c', type: 'document', content: '', originalName: 'locked.pdf', format: 'PDF', note: { code: 'failed', values: { reason: 'password' } } },
    ]));
    expect(content).toBe([
      'See attached',
      '',
      '[Attached file "tool.bin" (File, 7 B): not sent; FLUJO cannot read this file type]',
      '',
      '[Attached file "huge.mov" (QuickTime video): not sent; larger than the chat file limit (limit 64 MB)]',
      '',
      '[Attached file "locked.pdf" (PDF): not sent; it could not be read because it is protected with a password]',
    ].join('\n'));
  });

  it('names each image and PDF next to the bytes it sends', () => {
    const content = buildApiContent(message('Compare', [
      { id: 'a', type: 'image', content: 'data:image/png;base64,AAAA', originalName: 'photo.heic', format: 'HEIC photo', note: { code: 'image-converted', values: { format: 'HEIC photo' } } },
      { id: 'b', type: 'document', content: 'data:application/pdf;base64,BBBB', originalName: 'report.pdf', mimeType: 'application/pdf', format: 'PDF', note: { code: 'pdf', values: { pages: 3 } } },
    ]));
    expect(content).toEqual([
      { type: 'text', text: 'Compare' },
      { type: 'text', text: '[Attached file "photo.heic" (HEIC photo): converted to an image format models can read]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: '[Attached file "report.pdf" (PDF), 3 pages]' },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,BBBB', filename: 'report.pdf', mime_type: 'application/pdf' } },
    ]);
  });

  it('leaves out attachments that are still being read', () => {
    expect(buildApiContent(message('Hi', [{ id: 'a', type: 'document', content: '', originalName: 'big.zip', pending: true }]))).toBe('Hi');
  });
});
