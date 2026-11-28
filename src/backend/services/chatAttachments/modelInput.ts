import type OpenAI from 'openai';
import type { ChatAttachmentLimits } from '@/shared/chatAttachments/limits';
import type { Model } from '@/shared/types/model';
import { resolveModelAdapter } from '@/shared/types/model/provider';
import { parseDataUrl } from '@/backend/services/model/adapters/messageUtils';
import {
  attachedFileName,
  filterUnsupportedMediaInputs,
  supportedInputModalities,
} from '@/backend/services/model/mediaHandoff';
import { createLogger } from '@/utils/logger';
import { audioInputFor, modelHearsAudio, type AudioAbility } from './audioInput';
import { transcribeChatAudio, type Transcriber } from './audioTranscript';
import { currentChatAttachmentLimits } from './limits';
import { cachedPdfPages } from './pdfPageImages';
import { cachedPdfText } from './pdfTextCache';

const log = createLogger('backend/services/chatAttachments/modelInput');

type Message = OpenAI.ChatCompletionMessageParam;
type ModelIdentity = Pick<Model, 'provider' | 'adapter' | 'inputModalities'> & Partial<Pick<Model, 'name' | 'visionInputCapability' | 'contextWindow'>>;

/**
 * Whether a model reads PDF files itself. A catalogue entry decides when there
 * is one; otherwise the adapters that pass PDFs through to their provider do.
 */
export function modelReadsPdf(model: ModelIdentity): boolean {
  const known = supportedInputModalities(model.inputModalities);
  if (known.size > 0) return known.has('file');
  switch (resolveModelAdapter(model.provider, model.adapter)) {
    case 'anthropic':
    case 'gemini':
    case 'claude-cli':
    case 'openai-responses':
    case 'antigravity-cli':
      return true;
    case 'openai':
    case 'azure':
      return model.provider === undefined || model.provider === 'openai' || model.provider === 'azure';
    default:
      return false;
  }
}

/**
 * Whether a model sees pictures: its vision setting or catalogue entry
 * decides; otherwise the adapters whose providers all take images do.
 */
export function modelSeesImages(model: ModelIdentity): boolean {
  if (model.visionInputCapability === 'supported') return true;
  if (model.visionInputCapability === 'unsupported') return false;
  const known = supportedInputModalities(model.inputModalities);
  if (known.size > 0) return known.has('image');
  switch (resolveModelAdapter(model.provider, model.adapter)) {
    case 'anthropic':
    case 'gemini':
    case 'claude-cli':
    case 'codex-cli':
      return true;
    default:
      return false;
  }
}

function pdfDataUrl(part: Record<string, unknown>): string | undefined {
  if (part.type !== 'file' && part.type !== 'input_file') return undefined;
  const file = (part.file && typeof part.file === 'object' ? part.file : part) as Record<string, unknown>;
  const url = file.file_data ?? file.url ?? file.file_url;
  if (typeof url !== 'string' || !url.startsWith('data:')) return undefined;
  const mime = typeof file.mime_type === 'string' ? file.mime_type : parseDataUrl(url)?.mimeType;
  return mime === 'application/pdf' ? url : undefined;
}

const pagesText = (pages: number) => `${pages} ${pages === 1 ? 'page' : 'pages'}`;
const pageRange = (count: number) => (count === 1 ? 'page 1' : `pages 1-${count}`);

/** About what one page picture costs a vision model, in tokens. */
const TOKENS_PER_PAGE_PICTURE = 1600;
/** Used when a model does not say how much it can read at once. */
const ASSUMED_CONTEXT_WINDOW = 32_768;

/**
 * Pages drawn as pictures: as many as fit in half of the model's context
 * window, at least one, never more than the page setting.
 */
export function pagePictureCount(model: ModelIdentity, limits: ChatAttachmentLimits): number {
  const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : ASSUMED_CONTEXT_WINDOW;
  return Math.max(1, Math.min(limits.maxPages, Math.floor((window / 2) / TOKENS_PER_PAGE_PICTURE)));
}

async function pdfForModel(
  dataUrl: string,
  name: string,
  model: ModelIdentity,
  limits: ChatAttachmentLimits,
): Promise<unknown[]> {
  const label = `PDF "${name}"`;
  const bytes = Buffer.from(parseDataUrl(dataUrl)?.base64 ?? '', 'base64');
  let pdf: Awaited<ReturnType<typeof cachedPdfText>>;
  try {
    pdf = await cachedPdfText(bytes, limits);
  } catch (error) {
    log.warn('Could not turn a PDF attachment into text for a model without PDF support', error);
    return [{ type: 'text', text: `[${label} not sent: it could not be read.]` }];
  }
  const textPart = pdf.shortened?.unit === 'page'
    ? `; first ${pdf.shortened.kept} of ${pdf.shortened.total ?? pdf.pages} pages`
    : pdf.shortened ? '; shortened' : '';

  if (modelSeesImages(model)) {
    try {
      const pictures = await cachedPdfPages(bytes, { maxPages: pagePictureCount(model, limits), maxBytes: limits.maxInlineBytes });
      if (pictures.images.length > 0) {
        const shown = pictures.images.length;
        const rest = shown < pdf.pages
          ? ` Pages ${shown + 1}-${pdf.pages} were not drawn, to leave room in the conversation${pdf.hasText ? '; their text is included' : ''}.`
          : '';
        const head = pdf.hasText
          ? `[${label} (${pagesText(pdf.pages)}${textPart}). This model cannot read PDF files, so FLUJO sent its text and pictures of ${pageRange(shown)}.${rest}]\n${pdf.text}`
          : `[${label} (${pagesText(pdf.pages)}) has no text layer (it may be a scan). This model cannot read PDF files, so FLUJO sent pictures of ${pageRange(shown)}.${rest}]`;
        return [
          { type: 'text', text: head },
          ...pictures.images.flatMap(image => [
            { type: 'text', text: `[Page ${image.page} of "${name}"]` },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ]),
        ];
      }
    } catch (error) {
      log.warn('Could not draw PDF pages for a model that sees images; sending text instead', error);
    }
  }
  if (!pdf.hasText) {
    return [{ type: 'text', text: `[${label} (${pagesText(pdf.pages)}) not sent: this model cannot read PDF files and this one has no text layer (it may be a scan).]` }];
  }
  return [{ type: 'text', text: `[${label} (${pagesText(pdf.pages)}${textPart}). This model cannot read PDF files, so FLUJO sent its text:]\n${pdf.text}` }];
}

/**
 * iPhone photos (HEIC with HEVC) cannot be converted without a patent-encumbered
 * decoder, so the chat keeps the original. Only Gemini reads it directly.
 */
function heicImageMime(part: Record<string, unknown>): string | undefined {
  if (part.type !== 'image_url') return undefined;
  const image = part.image_url && typeof part.image_url === 'object' ? part.image_url as Record<string, unknown> : undefined;
  const url = image?.url;
  const mime = typeof url === 'string' ? parseDataUrl(url)?.mimeType.toLowerCase() : undefined;
  return mime === 'image/heic' || mime === 'image/heif' ? mime : undefined;
}

/** The chat composer puts `[Attached file "name" …]` right before each attachment. */
function composerFileName(previous: unknown): string | undefined {
  const text = (previous as { type?: unknown; text?: unknown } | undefined)?.type === 'text'
    ? (previous as { text: unknown }).text
    : undefined;
  return typeof text === 'string' ? /^\[Attached file "([^"]+)"/.exec(text)?.[1] : undefined;
}

function isTranscriptPart(part: unknown): boolean {
  const record = part as { type?: unknown; text?: unknown } | undefined;
  return record?.type === 'text' && typeof record.text === 'string' && record.text.startsWith('[Audio transcript]:');
}

/**
 * Fit attachments to the model about to answer (#1224): a model that cannot
 * read PDFs gets their text, plus pictures of their pages when it sees
 * images; a model that cannot listen gets a transcript of each sound file; a
 * model that cannot read HEIC photos gets a note; and a model whose catalogue
 * lists its inputs gets a short note in place of every other attachment it
 * cannot read. Nothing is dropped silently.
 */
export async function adaptMediaInputsForModel(
  messages: Message[],
  model: ModelIdentity,
  loadLimits: () => Promise<ChatAttachmentLimits> = currentChatAttachmentLimits,
  transcriber: Transcriber = transcribeChatAudio,
): Promise<Message[]> {
  const readsPdf = modelReadsPdf(model);
  const readsHeic = resolveModelAdapter(model.provider, model.adapter) === 'gemini';
  const hears: AudioAbility = modelHearsAudio(model);
  let limits: ChatAttachmentLimits | undefined;
  const adapted: Message[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { adapted.push(message); continue; }
    let changed = false;
    const content: unknown[] = [];
    const parts: unknown[] = message.content;
    for (const [index, rawPart] of parts.entries()) {
      const part = rawPart as Record<string, unknown>;
      const pdf = readsPdf ? undefined : pdfDataUrl(part);
      const heic = readsHeic ? undefined : heicImageMime(part);
      if (pdf) {
        limits ??= await loadLimits();
        content.push(...await pdfForModel(pdf, attachedFileName(part) ?? composerFileName(parts[index - 1]) ?? 'attachment.pdf', model, limits));
      } else if (heic) {
        content.push({ type: 'text', text: `[Attachment not sent: this model cannot read ${heic === 'image/heic' ? 'HEIC' : 'HEIF'} photos. Ask for a JPEG or PNG copy if it matters.]` });
      } else {
        const audio = await audioInputFor(part, {
          model,
          hears,
          name: composerFileName(parts[index - 1]),
          transcriptFollows: isTranscriptPart(parts[index + 1]),
          transcriber,
        });
        if (!audio) { content.push(rawPart); continue; }
        content.push(...audio);
      }
      changed = true;
    }
    adapted.push(changed ? { ...message, content } as Message : message);
  }
  const unchanged = adapted.every((message, index) => message === messages[index]);
  return filterUnsupportedMediaInputs(unchanged ? messages : adapted, model.inputModalities);
}
