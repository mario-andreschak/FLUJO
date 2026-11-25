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
import { currentChatAttachmentLimits } from './limits';
import { cachedPdfText } from './pdfTextCache';

const log = createLogger('backend/services/chatAttachments/modelInput');

type Message = OpenAI.ChatCompletionMessageParam;
type ModelIdentity = Pick<Model, 'provider' | 'adapter' | 'inputModalities'>;

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

function pdfDataUrl(part: Record<string, unknown>): string | undefined {
  if (part.type !== 'file' && part.type !== 'input_file') return undefined;
  const file = (part.file && typeof part.file === 'object' ? part.file : part) as Record<string, unknown>;
  const url = file.file_data ?? file.url ?? file.file_url;
  if (typeof url !== 'string' || !url.startsWith('data:')) return undefined;
  const mime = typeof file.mime_type === 'string' ? file.mime_type : parseDataUrl(url)?.mimeType;
  return mime === 'application/pdf' ? url : undefined;
}

const pagesText = (pages: number) => `${pages} ${pages === 1 ? 'page' : 'pages'}`;

async function pdfAsText(dataUrl: string, name: string, limits: ChatAttachmentLimits): Promise<string> {
  const label = `PDF "${name}"`;
  try {
    const payload = parseDataUrl(dataUrl)?.base64 ?? '';
    const pdf = await cachedPdfText(Buffer.from(payload, 'base64'), limits);
    if (!pdf.hasText) {
      return `[${label} (${pagesText(pdf.pages)}) not sent: this model cannot read PDF files and this one has no text layer (it may be a scan).]`;
    }
    const part = pdf.shortened?.unit === 'page'
      ? `; first ${pdf.shortened.kept} of ${pdf.shortened.total ?? pdf.pages} pages`
      : pdf.shortened ? '; shortened' : '';
    return `[${label} (${pagesText(pdf.pages)}${part}). This model cannot read PDF files, so FLUJO sent its text:]\n${pdf.text}`;
  } catch (error) {
    log.warn('Could not turn a PDF attachment into text for a model without PDF support', error);
    return `[${label} not sent: it could not be read.]`;
  }
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

/**
 * Fit attachments to the model about to answer (#1224): a model that cannot
 * read PDFs gets their text, a model that cannot read HEIC photos gets a note,
 * and a model whose catalogue lists its inputs gets a short note in place of
 * every other attachment it cannot read. Nothing is dropped silently.
 */
export async function adaptMediaInputsForModel(
  messages: Message[],
  model: ModelIdentity,
  loadLimits: () => Promise<ChatAttachmentLimits> = currentChatAttachmentLimits,
): Promise<Message[]> {
  const readsPdf = modelReadsPdf(model);
  const readsHeic = resolveModelAdapter(model.provider, model.adapter) === 'gemini';
  let limits: ChatAttachmentLimits | undefined;
  const adapted: Message[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { adapted.push(message); continue; }
    let changed = false;
    const content: unknown[] = [];
    const parts: unknown[] = message.content;
    for (const rawPart of parts) {
      const part = rawPart as Record<string, unknown>;
      const pdf = readsPdf ? undefined : pdfDataUrl(part);
      const heic = readsHeic ? undefined : heicImageMime(part);
      if (pdf) {
        limits ??= await loadLimits();
        content.push({ type: 'text', text: await pdfAsText(pdf, attachedFileName(part) ?? 'attachment.pdf', limits) });
      } else if (heic) {
        content.push({ type: 'text', text: `[Attachment not sent: this model cannot read ${heic === 'image/heic' ? 'HEIC' : 'HEIF'} photos. Ask for a JPEG or PNG copy if it matters.]` });
      } else {
        content.push(rawPart);
        continue;
      }
      changed = true;
    }
    adapted.push(changed ? { ...message, content } as Message : message);
  }
  const unchanged = adapted.every((message, index) => message === messages[index]);
  return filterUnsupportedMediaInputs(unchanged ? messages : adapted, model.inputModalities);
}
