import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import sharp from 'sharp';

jest.mock('@/backend/services/chatAttachments/pdfPageImages', () => {
  const actual = jest.requireActual('@/backend/services/chatAttachments/pdfPageImages');
  return { ...actual, cachedPdfPages: jest.fn(actual.cachedPdfPages) };
});

import { modelHearsAudio } from '@/backend/services/chatAttachments/audioInput';
import { cachedPdfPages } from '@/backend/services/chatAttachments/pdfPageImages';
import { adaptMediaInputsForModel, modelReadsPdf, modelSeesImages, pagePictureCount } from '@/backend/services/chatAttachments/modelInput';
import { buildApiContent, type Attachment } from '@/frontend/components/Chat/chatApiContent';
import type { ChatAttachmentLimits } from '@/shared/chatAttachments/limits';

const LIMITS: ChatAttachmentLimits = { maxFileBytes: 1 << 24, maxInlineBytes: 1 << 23, maxPages: 200, maxTextCharacters: 400_000 };
const loadLimits = async () => LIMITS;

async function pdfMessage(): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const bytes = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', 'sample.pdf'));
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'Summarise this.' },
      { type: 'file', file: { file_data: `data:application/pdf;base64,${bytes.toString('base64')}`, filename: 'report.pdf' } },
    ],
  }];
}

describe('fitting chat attachments to the model (#1224)', () => {
  it('knows which models read PDF files themselves', () => {
    expect(modelReadsPdf({ provider: 'anthropic', adapter: 'anthropic' })).toBe(true);
    expect(modelReadsPdf({ provider: 'gemini', adapter: 'gemini' })).toBe(true);
    expect(modelReadsPdf({ provider: 'openai', adapter: 'openai' })).toBe(true);
    expect(modelReadsPdf({ provider: 'openrouter' })).toBe(true);
    expect(modelReadsPdf({ provider: 'ollama', adapter: 'openai' })).toBe(false);
    expect(modelReadsPdf({ provider: 'codex', adapter: 'codex-cli' })).toBe(false);
    // A catalogue entry overrides the adapter's general ability.
    expect(modelReadsPdf({ provider: 'anthropic', adapter: 'anthropic', inputModalities: ['text', 'image'] })).toBe(false);
    expect(modelReadsPdf({ provider: 'ollama', adapter: 'openai', inputModalities: ['text', 'file'] })).toBe(true);
  });

  it('sends the PDF itself to a model that reads PDFs', async () => {
    const messages = await pdfMessage();
    await expect(adaptMediaInputsForModel(messages, { provider: 'anthropic', adapter: 'anthropic' }, loadLimits))
      .resolves.toBe(messages);
  });

  it('sends the text of the PDF to a model that cannot read PDFs', async () => {
    const adapted = await adaptMediaInputsForModel(await pdfMessage(), { provider: 'ollama', adapter: 'openai' }, loadLimits);
    expect(adapted).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Summarise this.' },
        {
          type: 'text',
          text: '[PDF "report.pdf" (2 pages). This model cannot read PDF files, so FLUJO sent its text:]\n'
            + '## Page 1\nQuarterly garden report\nTomatoes did well\n\n## Page 2\nPage two total 42',
        },
      ],
    }]);
  });

  it('replaces attachments a text-only model cannot read with a note instead of dropping them', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in these?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'file', file: { file_data: 'data:application/zip;base64,AAAA', filename: 'bundle.zip' } },
      ],
    }] as OpenAI.ChatCompletionMessageParam[];
    const adapted = await adaptMediaInputsForModel(messages, { provider: 'openai', adapter: 'openai', inputModalities: ['text'] }, loadLimits);
    expect(adapted[0].content).toEqual([
      { type: 'text', text: 'What is in these?' },
      { type: 'text', text: '[Attachment not sent: this model cannot read images.]' },
      { type: 'text', text: '[Attachment "bundle.zip" not sent: this model cannot read files of this type.]' },
    ]);
  });

  it('sends an unconverted HEIC photo only to Gemini and a note to other models', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/heic;base64,AAAA' } }],
    }] as OpenAI.ChatCompletionMessageParam[];
    await expect(adaptMediaInputsForModel(messages, { provider: 'gemini', adapter: 'gemini' }, loadLimits)).resolves.toBe(messages);
    const adapted = await adaptMediaInputsForModel(messages, { provider: 'anthropic', adapter: 'anthropic' }, loadLimits);
    expect(adapted[0].content).toEqual([{
      type: 'text',
      text: '[Attachment not sent: this model cannot read HEIC photos. Ask for a JPEG or PNG copy if it matters.]',
    }]);
  });

  it('says so when a PDF without text reaches a model that neither reads PDFs nor sees images', async () => {
    const bytes = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', 'scanned.pdf'));
    const adapted = await adaptMediaInputsForModel([{
      role: 'user',
      content: [{ type: 'file', file: { file_data: `data:application/pdf;base64,${bytes.toString('base64')}`, filename: 'scan.pdf' } }],
    }], { provider: 'ollama', adapter: 'openai' }, loadLimits);
    expect(adapted[0].content).toEqual([{
      type: 'text',
      text: '[PDF "scan.pdf" (1 page) not sent: this model cannot read PDF files and this one has no text layer (it may be a scan).]',
    }]);
  });
});

async function fixtureDataUrl(name: string, mimeType: string): Promise<string> {
  const bytes = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', name));
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function pictures(content: unknown): string[] {
  return (content as Array<{ type: string; image_url?: { url: string } }>)
    .filter(part => part.type === 'image_url')
    .map(part => part.image_url!.url);
}

function texts(content: unknown): string[] {
  return (content as Array<{ type: string; text?: string }>).filter(part => part.type === 'text').map(part => part.text!);
}

describe('PDF pages as pictures for models that see images but cannot read PDFs (#1224)', () => {
  const visionWithoutPdf = { provider: 'ollama' as const, adapter: 'openai' as const, visionInputCapability: 'supported' as const };

  it('knows which models see pictures', () => {
    expect(modelSeesImages(visionWithoutPdf)).toBe(true);
    expect(modelSeesImages({ provider: 'ollama', adapter: 'openai' })).toBe(false);
    expect(modelSeesImages({ provider: 'codex', adapter: 'codex-cli' })).toBe(true);
    expect(modelSeesImages({ provider: 'ollama', adapter: 'openai', inputModalities: ['text', 'image'] })).toBe(true);
    expect(modelSeesImages({ provider: 'anthropic', adapter: 'anthropic', visionInputCapability: 'unsupported' })).toBe(false);
  });

  it('sends the text and a picture of every page', async () => {
    const adapted = await adaptMediaInputsForModel(await pdfMessage(), visionWithoutPdf, loadLimits);
    const content = adapted[0].content;
    expect(texts(content)).toEqual([
      'Summarise this.',
      '[PDF "report.pdf" (2 pages). This model cannot read PDF files, so FLUJO sent its text and pictures of pages 1-2.]\n'
        + '## Page 1\nQuarterly garden report\nTomatoes did well\n\n## Page 2\nPage two total 42',
      '[Page 1 of "report.pdf"]',
      '[Page 2 of "report.pdf"]',
    ]);
    const urls = pictures(content);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.startsWith('data:image/png;base64,')).toBe(true);
      const metadata = await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata();
      // A US Letter page, drawn 1400 pixels tall.
      expect([metadata.width, metadata.height]).toEqual([1081, 1400]);
    }
  });

  it('draws a scanned page so the model can see what is on it', async () => {
    const adapted = await adaptMediaInputsForModel([{
      role: 'user',
      content: [{ type: 'file', file: { file_data: await fixtureDataUrl('scanned.pdf', 'application/pdf'), filename: 'scan.pdf' } }],
    }], { provider: 'codex', adapter: 'codex-cli' }, loadLimits);
    expect(texts(adapted[0].content)).toEqual([
      '[PDF "scan.pdf" (1 page) has no text layer (it may be a scan). This model cannot read PDF files, so FLUJO sent pictures of page 1.]',
      '[Page 1 of "scan.pdf"]',
    ]);
    const [url] = pictures(adapted[0].content);
    const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    // The page holds one blue rectangle (0.2, 0.4, 0.8) on white paper.
    expect(pixel(300, 250)).toEqual([51, 102, 204]);
    expect(pixel(20, 20)).toEqual([255, 255, 255]);
  });

  it('draws only as many pages as fit the model, and says which pages were left out', async () => {
    const adapted = await adaptMediaInputsForModel(await pdfMessage(), { ...visionWithoutPdf, contextWindow: 4000 }, loadLimits);
    expect(pagePictureCount({ ...visionWithoutPdf, contextWindow: 4000 }, LIMITS)).toBe(1);
    expect(pagePictureCount({ ...visionWithoutPdf, contextWindow: 1_000_000 }, LIMITS)).toBe(200);
    expect(pictures(adapted[0].content)).toHaveLength(1);
    expect(texts(adapted[0].content)[1]).toContain('pictures of page 1. Pages 2-2 were not drawn, to leave room in the conversation; their text is included.]');
  });

  it('falls back to the text when the pages cannot be drawn', async () => {
    jest.mocked(cachedPdfPages).mockRejectedValueOnce(new Error('the drawing engine did not start'));
    const adapted = await adaptMediaInputsForModel(await pdfMessage(), visionWithoutPdf, loadLimits);
    expect(pictures(adapted[0].content)).toHaveLength(0);
    expect(texts(adapted[0].content)[1]).toBe('[PDF "report.pdf" (2 pages). This model cannot read PDF files, so FLUJO sent its text:]\n'
      + '## Page 1\nQuarterly garden report\nTomatoes did well\n\n## Page 2\nPage two total 42');
  });

  it('keeps the pictures of one PDF within what one message can carry', async () => {
    const adapted = await adaptMediaInputsForModel(await pdfMessage(), visionWithoutPdf, async () => ({ ...LIMITS, maxInlineBytes: 1000 }));
    expect(pictures(adapted[0].content)).toHaveLength(1);
  });
});

describe('sound files for models that cannot listen (#1224)', () => {
  const transcribed = (text: string) => jest.fn(async () => ({ kind: 'text' as const, text }));

  async function soundMessage(name: string, mimeType: string): Promise<OpenAI.ChatCompletionMessageParam[]> {
    const bytes = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', name));
    const attachment: Attachment = {
      id: name,
      type: 'audio',
      content: `data:${mimeType};base64,${bytes.toString('base64')}`,
      originalName: name,
      mimeType,
      size: bytes.length,
      format: 'Audio',
      note: { code: 'audio' },
    };
    // The chat sends FLUJO's audio parts, which the model adapters read but OpenAI's types do not list.
    const content = buildApiContent({ role: 'user', content: 'What is this?', attachments: [attachment] } as Parameters<typeof buildApiContent>[0]);
    return [{ role: 'user', content: content as OpenAI.ChatCompletionUserMessageParam['content'] }];
  }

  it('knows which models listen', () => {
    expect(modelHearsAudio({ provider: 'gemini', adapter: 'gemini' })).toBe('yes');
    expect(modelHearsAudio({ provider: 'anthropic', adapter: 'anthropic' })).toBe('no');
    expect(modelHearsAudio({ provider: 'openai', adapter: 'openai', name: 'gpt-4o-audio-preview' })).toBe('yes');
    expect(modelHearsAudio({ provider: 'openai', adapter: 'openai', name: 'gpt-5' })).toBe('no');
    expect(modelHearsAudio({ provider: 'ollama', adapter: 'openai' })).toBe('unknown');
    expect(modelHearsAudio({ provider: 'openrouter', inputModalities: ['text', 'audio'] })).toBe('yes');
  });

  it('sends the sound itself to a model that listens and takes its format', async () => {
    const transcriber = transcribed('unused');
    for (const [name, mime, model] of [
      ['sample.ogg', 'audio/ogg', { provider: 'gemini', adapter: 'gemini' }],
      ['sample.mp3', 'audio/mpeg', { provider: 'openai', adapter: 'openai', name: 'gpt-4o-audio-preview' }],
    ] as const) {
      const messages = await soundMessage(name, mime);
      await expect(adaptMediaInputsForModel(messages, model, loadLimits, transcriber)).resolves.toBe(messages);
    }
    expect(transcriber).not.toHaveBeenCalled();
  });

  it('sends a transcript to a model that cannot listen', async () => {
    const transcriber = transcribed('Meet at the garden gate at noon.');
    const messages = await soundMessage('sample.wav', 'audio/wav');
    const adapted = await adaptMediaInputsForModel(messages, { provider: 'anthropic', adapter: 'anthropic' }, loadLimits, transcriber);
    expect(texts(adapted[0].content)).toEqual([
      'What is this?',
      '[Attached file "sample.wav" (Audio, 8 KB)]',
      '[Audio "sample.wav": this model cannot listen to audio, so FLUJO sent a transcript:]\nMeet at the garden gate at noon.',
    ]);
    expect((adapted[0].content as unknown[]).some(part => (part as { type: string }).type !== 'text')).toBe(false);
    const wav = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', 'sample.wav'));
    expect(transcriber).toHaveBeenCalledWith({ bytes: wav, mimeType: 'audio/wav', name: 'sample.wav' });
  });

  it('sends a transcript when a listening model does not take the format', async () => {
    const adapted = await adaptMediaInputsForModel(await soundMessage('sample.ogg', 'audio/ogg'),
      { provider: 'openai', adapter: 'openai', name: 'gpt-4o-audio-preview' }, loadLimits, transcribed('Hello.'));
    expect(texts(adapted[0].content).at(-1)).toBe('[Audio "sample.ogg": this model cannot take audio/ogg sound, so FLUJO sent a transcript:]\nHello.');
  });

  it('says clearly what is missing when no transcript can be made', async () => {
    const model = { provider: 'anthropic' as const, adapter: 'anthropic' as const };
    const noModel = await adaptMediaInputsForModel(await soundMessage('sample.mp3', 'audio/mpeg'), model, loadLimits, async () => ({ kind: 'no-model' }));
    expect(texts(noModel[0].content).at(-1)).toBe('[Audio "sample.mp3" not sent: this model cannot listen to audio, and no transcription model is set up. Choose one in Settings > Speech to get transcripts.]');
    const failed = await adaptMediaInputsForModel(await soundMessage('sample.mp3', 'audio/mpeg'), model, loadLimits, async () => ({ kind: 'failed', reason: 'it took too long' }));
    expect(texts(failed[0].content).at(-1)).toBe('[Audio "sample.mp3" not sent: this model cannot listen to audio, and making a transcript failed (it took too long). FLUJO tries again with the next message.]');
  });

  it('keeps the sound for a model of unknown ability when no transcript can be made', async () => {
    const messages = await soundMessage('sample.mp3', 'audio/mpeg');
    await expect(adaptMediaInputsForModel(messages, { provider: 'ollama', adapter: 'openai' }, loadLimits, async () => ({ kind: 'no-model' })))
      .resolves.toBe(messages);
  });

  it('does not transcribe a voice recording that already has its transcript', async () => {
    const transcriber = transcribed('unused');
    const messages: OpenAI.ChatCompletionMessageParam[] = [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
        { type: 'text', text: '[Audio transcript]: water the beans' },
      ],
    }];
    const adapted = await adaptMediaInputsForModel(messages, { provider: 'anthropic', adapter: 'anthropic' }, loadLimits, transcriber);
    expect(adapted[0].content).toEqual([
      { type: 'text', text: '[Audio not sent: this model cannot listen to audio; its transcript follows.]' },
      { type: 'text', text: '[Audio transcript]: water the beans' },
    ]);
    expect(transcriber).not.toHaveBeenCalled();
  });
});
