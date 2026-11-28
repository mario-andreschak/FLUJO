import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { fenceFor, formatBytes } from '@/shared/chatAttachments/formats';
import { isNameOnlyNote, type AttachmentNote } from '@/shared/chatAttachments/limits';

export interface Attachment {
  id: string;
  type: 'document' | 'audio' | 'image' | 'video';
  // Plain documents contain text. Binary audio/image/video attachments use a
  // `data:` URL; audio transcription text is kept separately below.
  content: string;
  originalName?: string;
  mimeType?: string;
  /** Optional text transcript retained alongside a raw audio attachment. */
  transcript?: string;
  /** What the chip shows and the model is told about this file (#1224). */
  note?: AttachmentNote;
  /** Size of the original file in bytes. */
  size?: number;
  /** Short format name, e.g. "Word document". */
  format?: string;
  /** Code fence language of a text file. */
  language?: string;
  /** Still being read or converted; sending waits until it is ready. */
  pending?: boolean;
}

export type ChatMessage = FlujoChatMessage & {
  attachments?: Attachment[];
};

/**
 * One part of a message as the chat sends it: OpenAI's text, image and audio
 * parts, plus the audio, video and file parts (with their media type) that
 * FLUJO's model adapters read.
 */
export type ApiContentPart =
  | OpenAI.ChatCompletionContentPartText
  | OpenAI.ChatCompletionContentPartImage
  | OpenAI.ChatCompletionContentPartInputAudio
  | { type: 'audio_url'; audio_url: { url: string; mime_type?: string } }
  | { type: 'video_url'; video_url: { url: string; mime_type?: string } }
  | { type: 'file'; file: { file_data: string; filename?: string; mime_type?: string } };

export type ApiContent = string | ApiContentPart[];

const UNIT_WORDS: Record<string, string> = { page: 'pages', slide: 'slides', sheet: 'sheets', file: 'files', character: 'characters' };

function shortenedText(note: AttachmentNote): string {
  const shortened = note.shortened;
  if (!shortened) return '';
  if (shortened.unit === 'character') return `; shortened to the first ${shortened.kept} characters`;
  return `; only the first ${shortened.kept}${shortened.total ? ` of ${shortened.total}` : ''} ${UNIT_WORDS[shortened.unit]} were read`;
}

function limitText(note: AttachmentNote): string {
  const limit = Number(note.values?.limit);
  return Number.isFinite(limit) && limit > 0 ? ` (limit ${formatBytes(limit)})` : '';
}

/** The line the model reads about an attachment added through the chat composer. */
export function attachmentLabel(attachment: Attachment, note: AttachmentNote): string {
  const name = attachment.originalName || 'attachment';
  const facts = [attachment.format, attachment.size ? formatBytes(attachment.size) : undefined].filter(Boolean).join(', ');
  const head = `Attached file "${name}"${facts ? ` (${facts})` : ''}`;
  const pages = note.values?.pages ? `, ${note.values.pages} pages` : '';
  switch (note.code) {
    case 'text': return `[${head}${shortenedText(note)}]`;
    case 'text-extracted': return `[${head}: text extracted${shortenedText(note)}]`;
    case 'archive': return `[${head}: list of files and the text of readable files${shortenedText(note)}]`;
    case 'pdf': return `[${head}${pages}]`;
    case 'pdf-no-text': return `[${head}${pages}; it has no text layer, so a model that cannot read PDF files sees it only as page pictures, when it sees images]`;
    case 'pdf-as-text': return `[${head}${pages}: too large to send as a PDF, so its text was extracted${shortenedText(note)}]`;
    case 'image-converted': return `[${head}: converted to an image format models can read]`;
    case 'image-reduced': return `[${head}: made smaller so it fits in the message]`;
    case 'image-original': return `[${head}: sent as it is; models that cannot read this format get a note instead]`;
    case 'image':
    case 'audio':
    case 'video': return `[${head}]`;
    case 'legacy-office': return `[${head}: not sent; FLUJO cannot read this Office file (it may come from a version older than Office 97). Ask for a .docx, .xlsx or .pptx copy if it matters]`;
    case 'too-large': return `[${head}: not sent; larger than the chat file limit${limitText(note)}]`;
    case 'too-large-to-send': return `[${head}: not sent; too large to send to a model${limitText(note)}]`;
    case 'failed': return `[${head}: not sent; it could not be read${note.values?.reason === 'password' ? ' because it is protected with a password' : ''}]`;
    case 'name-only':
    default: return `[${head}: not sent; FLUJO cannot read this file type]`;
  }
}

function documentBlock(attachment: Attachment, note: AttachmentNote): string {
  const label = attachmentLabel(attachment, note);
  if (note.code === 'text') {
    const fence = fenceFor(attachment.content);
    return `${label}\n${fence}${attachment.language ?? ''}\n${attachment.content}\n${fence}`;
  }
  return `${label}\n${attachment.content}\n[End of "${attachment.originalName || 'attachment'}"]`;
}

/**
 * Build the OpenAI-wire content for a message about to be sent to the API.
 * Kept independent from the Chat render tree so serializers and their tests do
 * not load UI-only dependencies such as Markdown renderers.
 */
export function buildApiContent(
  msg: ChatMessage,
): ApiContent {
  if (Array.isArray(msg.content)) {
    return msg.content as ApiContentPart[];
  }

  let text = typeof msg.content === 'string' ? msg.content : '';
  const attachments = (msg.attachments ?? []).filter(attachment => !attachment.pending);
  const textBlocks: string[] = [];
  const media: Attachment[] = [];
  for (const attachment of attachments) {
    const note = attachment.note;
    if (note && isNameOnlyNote(note)) textBlocks.push(attachmentLabel(attachment, note));
    else if (attachment.type === 'document' && !attachment.content.startsWith('data:')) {
      textBlocks.push(note ? documentBlock(attachment, note) : `[DOCUMENT]: ${attachment.content}`);
    } else media.push(attachment);
  }

  if (textBlocks.length > 0) {
    text += (text ? '\n\n' : '') + textBlocks.join('\n\n');
  }
  if (media.length === 0) {
    return text;
  }

  const parts: ApiContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });

  for (const attachment of media) {
    if (attachment.note) parts.push({ type: 'text', text: attachmentLabel(attachment, attachment.note) });
    if (attachment.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: attachment.content } });
    } else if (attachment.type === 'audio') {
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(attachment.content);
      const mimeType = attachment.mimeType ?? match?.[1];

      if (match && (mimeType === 'audio/wav' || mimeType === 'audio/mpeg')) {
        parts.push({
          type: 'input_audio',
          input_audio: {
            data: match[2],
            format: mimeType === 'audio/mpeg' ? 'mp3' : 'wav',
          },
        });
      } else {
        parts.push({
          type: 'audio_url',
          audio_url: { url: attachment.content, mime_type: mimeType },
        });
      }

      if (attachment.transcript) {
        parts.push({
          type: 'text',
          text: `[Audio transcript]: ${attachment.transcript}`,
        });
      }
    } else if (attachment.type === 'video') {
      parts.push({
        type: 'video_url',
        video_url: {
          url: attachment.content,
          mime_type: attachment.mimeType,
        },
      });
    } else {
      parts.push({
        type: 'file',
        file: {
          file_data: attachment.content,
          filename: attachment.originalName,
          mime_type: attachment.mimeType,
        },
      });
    }
  }

  return parts;
}
