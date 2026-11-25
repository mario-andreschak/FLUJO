import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import { adaptMediaInputsForModel, modelReadsPdf } from '@/backend/services/chatAttachments/modelInput';
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

  it('says so when a PDF without text reaches a model that cannot read PDFs', async () => {
    const bytes = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', 'scanned.pdf'));
    const adapted = await adaptMediaInputsForModel([{
      role: 'user',
      content: [{ type: 'file', file: { file_data: `data:application/pdf;base64,${bytes.toString('base64')}`, filename: 'scan.pdf' } }],
    }], { provider: 'codex', adapter: 'codex-cli' }, loadLimits);
    expect(adapted[0].content).toEqual([{
      type: 'text',
      text: '[PDF "scan.pdf" (1 page) not sent: this model cannot read PDF files and this one has no text layer (it may be a scan).]',
    }]);
  });
});
