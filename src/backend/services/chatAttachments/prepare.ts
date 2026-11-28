import { classifyAttachment, looksLikeText, type AttachmentClassification } from '@/shared/chatAttachments/formats';
import type { AttachmentNote, ChatAttachmentLimits } from '@/shared/chatAttachments/limits';
import { createLogger } from '@/utils/logger';
import { extractArchiveText } from './archiveText';
import { isCompoundFile, LegacyOfficeError } from './compoundFile';
import { convertImage, ImageConvertError } from './imageConvert';
import { extractLegacyOfficeText } from './legacyOffice';
import { maxPartBytes } from './limits';
import { detectOfficeKind, extractOfficeText, type ExtractLimits } from './officeText';
import { PdfReadError } from './pdfText';
import { cachedPdfText } from './pdfTextCache';
import { openZip } from './zipEntries';

const log = createLogger('backend/services/chatAttachments/prepare');

/** What the chat composer attaches after the server looked at a file (#1224). */
export type PreparedAttachment =
  /** Text that replaces the file: extracted from a document, archive or oversized PDF. */
  | { kind: 'text'; text: string; note: AttachmentNote }
  /** A converted or shrunk image to send instead of the original. */
  | { kind: 'image'; dataUrl: string; mimeType: string; note: AttachmentNote }
  /** The PDF is sent as it is; models that cannot read PDFs get its text later. */
  | { kind: 'pdf'; pages: number; hasText: boolean; note: AttachmentNote }
  /** Nothing readable: only a short note with the name reaches the model. */
  | { kind: 'note'; note: AttachmentNote };

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  if (base.endsWith('.tar.gz')) return 'tgz';
  return base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
}

function failed(reason: string): PreparedAttachment {
  return { kind: 'note', note: { code: 'failed', values: { reason } } };
}

function plainText(bytes: Uint8Array, maxCharacters: number): PreparedAttachment {
  const text = new TextDecoder('utf-8').decode(bytes);
  const kept = text.slice(0, maxCharacters);
  return {
    kind: 'text',
    text: kept,
    note: {
      code: 'text',
      ...(kept.length < text.length ? { shortened: { unit: 'character' as const, kept: kept.length, total: text.length } } : {}),
    },
  };
}

const startsWithZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

/**
 * Word, Excel and PowerPoint files by what they contain: the ZIP formats,
 * the old compound-file formats, and the HTML or CSV text many programs save
 * under an Office name.
 */
async function officeDocument(
  bytes: Uint8Array,
  name: string,
  kind: AttachmentClassification,
  extract: ExtractLimits,
): Promise<PreparedAttachment> {
  if (isCompoundFile(bytes)) {
    const result = await extractLegacyOfficeText(bytes, extract);
    return {
      kind: 'text',
      text: result.text || '(The document has no text.)',
      note: { code: 'text-extracted', values: { format: result.format }, ...(result.shortened ? { shortened: result.shortened } : {}) },
    };
  }
  if (startsWithZip(bytes) || kind.family === 'document') {
    const zip = await openZip(bytes);
    const office = await detectOfficeKind(zip, extensionOf(name));
    if (!office) return failed('not-a-document');
    const result = await extractOfficeText(zip, office, extract);
    return {
      kind: 'text',
      text: result.text || '(The document has no text.)',
      note: { code: 'text-extracted', values: { format: kind.format }, ...(result.shortened ? { shortened: result.shortened } : {}) },
    };
  }
  if (looksLikeText(bytes.subarray(0, 4096))) return plainText(bytes, extract.maxTextCharacters);
  return { kind: 'note', note: { code: 'legacy-office', values: { format: kind.format } } };
}

export async function prepareChatAttachment(input: {
  bytes: Uint8Array;
  name: string;
  mimeType?: string;
  limits: ChatAttachmentLimits;
}): Promise<PreparedAttachment> {
  const { bytes, name, limits } = input;
  const kind = classifyAttachment(name, input.mimeType);
  const extract = { maxPages: limits.maxPages, maxTextCharacters: limits.maxTextCharacters, maxPartBytes: maxPartBytes(limits) };

  try {
    switch (kind.family) {
      case 'document':
      case 'legacy-office':
        return await officeDocument(bytes, name, kind, extract);
      case 'archive': {
        const result = await extractArchiveText(bytes, name, extract);
        return {
          kind: 'text',
          text: result.text,
          note: { code: 'archive', values: { files: result.files }, ...(result.shortened ? { shortened: result.shortened } : {}) },
        };
      }
      case 'pdf': {
        const pdf = await cachedPdfText(bytes, limits);
        if (bytes.byteLength <= limits.maxInlineBytes) {
          return {
            kind: 'pdf',
            pages: pdf.pages,
            hasText: pdf.hasText,
            note: { code: pdf.hasText ? 'pdf' : 'pdf-no-text', values: { pages: pdf.pages } },
          };
        }
        if (!pdf.hasText) {
          return { kind: 'note', note: { code: 'too-large-to-send', values: { limit: limits.maxInlineBytes } } };
        }
        return {
          kind: 'text',
          text: pdf.text,
          note: { code: 'pdf-as-text', values: { pages: pdf.pages }, ...(pdf.shortened ? { shortened: pdf.shortened } : {}) },
        };
      }
      case 'image':
      case 'image-convert': {
        const image = await convertImage(bytes, kind.mimeType, limits.maxInlineBytes).catch(async (error: unknown) => {
          // Most iPhone photos are HEIC with HEVC, which this computer cannot decode.
          // Gemini reads them as they are, so the original is kept for it.
          if (/^image\/hei[cf]$/.test(kind.mimeType) && bytes.byteLength <= limits.maxInlineBytes) return undefined;
          throw error;
        });
        if (!image) {
          return {
            kind: 'image',
            dataUrl: `data:${kind.mimeType};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`,
            mimeType: kind.mimeType,
            note: { code: 'image-original', values: { format: kind.format } },
          };
        }
        return {
          kind: 'image',
          dataUrl: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`,
          mimeType: image.mimeType,
          note: kind.family === 'image'
            ? { code: 'image-reduced', values: { width: image.width, height: image.height } }
            : { code: 'image-converted', values: { format: kind.format } },
        };
      }
      case 'text':
        if (!looksLikeText(bytes.subarray(0, 4096))) return { kind: 'note', note: { code: 'name-only' } };
        return plainText(bytes, limits.maxTextCharacters);
      default:
        return { kind: 'note', note: { code: 'name-only' } };
    }
  } catch (error) {
    if (error instanceof PdfReadError) return failed(error.reason === 'password' ? 'password' : 'damaged');
    if (error instanceof LegacyOfficeError) {
      if (error.reason === 'unsupported') return { kind: 'note', note: { code: 'legacy-office', values: { format: kind.format } } };
      return failed(error.reason);
    }
    if (error instanceof ImageConvertError) return failed('image');
    log.warn(`Could not prepare chat attachment (${kind.family})`, error);
    return failed('damaged');
  }
}
