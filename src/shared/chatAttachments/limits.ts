/** Chat attachment limits (#1224). Each one is a setting the user can change in Settings > Chat files. */
export interface ChatAttachmentSettings {
  /** Largest file the chat reads. Missing: scales with the computer's memory. */
  maxFileMegabytes?: number;
  /** Most pages, slides or sheets read from one document. Missing: 200. */
  maxPages?: number;
  /** Most characters of text kept from one file. Missing: 400,000 (about 100,000 words). */
  maxTextCharacters?: number;
}

export interface ChatAttachmentLimits {
  maxFileBytes: number;
  /**
   * Largest file sent to a model as raw bytes (images, sound, video, PDF).
   * Derived from the run input limit, so it follows that limit automatically.
   */
  maxInlineBytes: number;
  maxPages: number;
  maxTextCharacters: number;
}

const MiB = 1024 * 1024;

export const CHAT_ATTACHMENT_BOUNDS = {
  // Requests above 100 MB are cut short by the local request proxy.
  maxFileMegabytes: { min: 1, max: 96 },
  maxPages: { min: 1, max: 5000 },
  maxTextCharacters: { min: 1000, max: 5_000_000 },
} as const;

export const CHAT_ATTACHMENT_DEFAULTS = {
  maxPages: 200,
  maxTextCharacters: 400_000,
} as const;

/** 1/512 of the computer's memory, between 16 and 64 MB: 64 MB on a 32 GB machine. */
export function defaultMaxFileBytes(totalMemoryBytes: number): number {
  const scaled = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes / 512 : 16 * MiB;
  return Math.round(Math.min(64 * MiB, Math.max(16 * MiB, scaled)));
}

/**
 * A run refuses input above its byte limit. Strings count twice (UTF-16) and
 * base64 adds a third, so one inline file gets a sixth of the limit and leaves
 * room for the rest of the conversation.
 */
export function inlineBytesForRunInputLimit(runInputLimitBytes: number): number {
  return Math.max(MiB, Math.floor(runInputLimitBytes / 6));
}

function bounded(value: unknown, bounds: { min: number; max: number }): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return undefined;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(number)));
}

/** Settings as saved: out-of-range values are clamped, unusable ones dropped. */
export function normalizeChatAttachmentSettings(settings: ChatAttachmentSettings | undefined): ChatAttachmentSettings {
  const maxFileMegabytes = bounded(settings?.maxFileMegabytes, CHAT_ATTACHMENT_BOUNDS.maxFileMegabytes);
  const maxPages = bounded(settings?.maxPages, CHAT_ATTACHMENT_BOUNDS.maxPages);
  const maxTextCharacters = bounded(settings?.maxTextCharacters, CHAT_ATTACHMENT_BOUNDS.maxTextCharacters);
  return {
    ...(maxFileMegabytes !== undefined ? { maxFileMegabytes } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(maxTextCharacters !== undefined ? { maxTextCharacters } : {}),
  };
}

export function resolveChatAttachmentLimits(
  settings: ChatAttachmentSettings | undefined,
  machine: { defaultMaxFileBytes: number; maxInlineBytes: number },
): ChatAttachmentLimits {
  const chosen = normalizeChatAttachmentSettings(settings);
  const maxFileBytes = chosen.maxFileMegabytes !== undefined ? chosen.maxFileMegabytes * MiB : machine.defaultMaxFileBytes;
  return {
    maxFileBytes,
    maxInlineBytes: Math.min(maxFileBytes, machine.maxInlineBytes),
    maxPages: chosen.maxPages ?? CHAT_ATTACHMENT_DEFAULTS.maxPages,
    maxTextCharacters: chosen.maxTextCharacters ?? CHAT_ATTACHMENT_DEFAULTS.maxTextCharacters,
  };
}

/** Used until the server answers, and if it cannot: the smallest machine default. */
export const FALLBACK_CHAT_ATTACHMENT_LIMITS: ChatAttachmentLimits = {
  maxFileBytes: 16 * MiB,
  maxInlineBytes: inlineBytesForRunInputLimit(64 * MiB),
  maxPages: CHAT_ATTACHMENT_DEFAULTS.maxPages,
  maxTextCharacters: CHAT_ATTACHMENT_DEFAULTS.maxTextCharacters,
};

/** What a chip says about one attachment; `code` picks the translated sentence. */
export type AttachmentNoteCode =
  | 'text'
  | 'text-extracted'
  | 'image'
  | 'image-converted'
  | 'image-reduced'
  /** Kept as it is because this computer cannot convert it (HEIC from iPhones). */
  | 'image-original'
  | 'pdf'
  | 'pdf-as-text'
  | 'pdf-no-text'
  | 'audio'
  | 'video'
  | 'archive'
  | 'name-only'
  | 'legacy-office'
  | 'too-large'
  | 'too-large-to-send'
  | 'failed';

export type AttachmentShortenedUnit = 'page' | 'slide' | 'sheet' | 'file' | 'character';

export interface AttachmentNote {
  code: AttachmentNoteCode;
  /** Values for the translated sentence, e.g. `{ format: 'Word document' }`. */
  values?: Record<string, string | number>;
  /** Set when only part of the file was kept. */
  shortened?: { unit: AttachmentShortenedUnit; kept: number; total?: number };
}

/** Notes whose file content does not reach the model; only a short note does. */
export function isNameOnlyNote(note: AttachmentNote | undefined): boolean {
  return note?.code === 'name-only' || note?.code === 'legacy-office' || note?.code === 'too-large'
    || note?.code === 'too-large-to-send' || note?.code === 'failed';
}
