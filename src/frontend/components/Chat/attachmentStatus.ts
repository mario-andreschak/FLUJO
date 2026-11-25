import type { PluralTranslationKey, TranslationKey, TranslationValues } from '@/frontend/i18n';
import { formatBytes } from '@/shared/chatAttachments/formats';
import type { AttachmentNote } from '@/shared/chatAttachments/limits';

type Translate = (key: TranslationKey, values?: TranslationValues) => string;
type TranslatePlural = (key: PluralTranslationKey, count: number, values?: TranslationValues) => string;

const SHORTENED_KEYS: Record<NonNullable<AttachmentNote['shortened']>['unit'], TranslationKey> = {
  page: 'chat.attachments.shortenedPage',
  slide: 'chat.attachments.shortenedSlide',
  sheet: 'chat.attachments.shortenedSheet',
  file: 'chat.attachments.shortenedFile',
  character: 'chat.attachments.shortenedCharacter',
};

function count(note: AttachmentNote, name: string): number {
  const value = Number(note.values?.[name]);
  return Number.isFinite(value) ? value : 0;
}

/** The short line under a chip's file name: what is sent for this file (#1224). */
export function attachmentStatusText(note: AttachmentNote, t: Translate, tp: TranslatePlural): string {
  const limit = formatBytes(count(note, 'limit'));
  let text: string;
  switch (note.code) {
    case 'text': text = t('chat.attachments.text'); break;
    case 'text-extracted': text = t('chat.attachments.textExtracted'); break;
    case 'archive': text = tp('chat.attachments.archive', count(note, 'files')); break;
    case 'pdf': text = tp('chat.attachments.pdf', count(note, 'pages')); break;
    case 'pdf-no-text': text = t('chat.attachments.pdfNoText'); break;
    case 'pdf-as-text': text = t('chat.attachments.pdfAsText'); break;
    case 'image': text = t('chat.attachments.image'); break;
    case 'image-converted': text = t('chat.attachments.imageConverted'); break;
    case 'image-reduced': text = t('chat.attachments.imageReduced'); break;
    case 'image-original': text = t('chat.attachments.imageOriginal'); break;
    case 'audio': text = t('chat.attachments.audio'); break;
    case 'video': text = t('chat.attachments.video'); break;
    case 'legacy-office': text = t('chat.attachments.legacyOffice'); break;
    case 'too-large': text = t('chat.attachments.tooLarge', { limit }); break;
    case 'too-large-to-send': text = t('chat.attachments.tooLargeToSend', { limit }); break;
    case 'failed': text = note.values?.reason === 'password' ? t('chat.attachments.password') : t('chat.attachments.failed'); break;
    case 'name-only':
    default: text = t('chat.attachments.nameOnly');
  }
  const shortened = note.shortened;
  if (!shortened) return text;
  return `${text} · ${t(SHORTENED_KEYS[shortened.unit], { kept: shortened.kept, total: shortened.total ?? shortened.kept })}`;
}
