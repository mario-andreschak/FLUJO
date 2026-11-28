import { v4 as uuidv4 } from 'uuid';
import { classifyAttachment, looksLikeText, type AttachmentClassification } from '@/shared/chatAttachments/formats';
import {
  FALLBACK_CHAT_ATTACHMENT_LIMITS,
  resolveChatAttachmentLimits,
  type AttachmentNote,
  type ChatAttachmentLimits,
  type ChatAttachmentSettings,
} from '@/shared/chatAttachments/limits';
import { createLogger } from '@/utils/logger';
import type { Attachment } from './chatApiContent';

const log = createLogger('frontend/components/Chat/attachmentIntake');

/**
 * Turns any file dropped, pasted or picked in the chat into an attachment
 * (#1224). Text, images, sound and video are read in the browser. Documents
 * (old Office formats too), archives, PDFs and unusual images go to the
 * server, which extracts text or converts them. Every file ends up as a chip: when nothing readable comes
 * out, the chip and the model get a short note instead.
 */
export type PreparedResponse =
  | { kind: 'text'; text: string; note: AttachmentNote }
  | { kind: 'image'; dataUrl: string; mimeType: string; note: AttachmentNote }
  | { kind: 'pdf'; pages: number; hasText: boolean; note: AttachmentNote }
  | { kind: 'note'; note: AttachmentNote };

export interface IntakeServer {
  /** The computer's default file limit and the most one message can carry. */
  machineDefaults(): Promise<{ defaultMaxFileBytes: number; maxInlineBytes: number } | undefined>;
  prepare(file: File, classification: AttachmentClassification): Promise<PreparedResponse>;
}

function isPrepared(value: unknown): value is PreparedResponse {
  const record = value as { kind?: unknown; note?: { code?: unknown } } | null;
  return !!record && typeof record.kind === 'string' && typeof record.note?.code === 'string';
}

let machineDefaultsRequest: Promise<{ defaultMaxFileBytes: number; maxInlineBytes: number } | undefined> | undefined;

export const httpIntakeServer: IntakeServer = {
  machineDefaults() {
    machineDefaultsRequest ??= Promise.resolve()
      .then(() => fetch('/api/chat/attachments'))
      .then(response => (response.ok ? response.json() : undefined))
      .then((body?: { defaults?: { defaultMaxFileBytes?: unknown; maxInlineBytes?: unknown } }) => {
        const defaults = body?.defaults;
        if (typeof defaults?.defaultMaxFileBytes !== 'number' || typeof defaults.maxInlineBytes !== 'number') return undefined;
        return { defaultMaxFileBytes: defaults.defaultMaxFileBytes, maxInlineBytes: defaults.maxInlineBytes };
      })
      .catch(() => undefined)
      .then(defaults => {
        // A failed answer is not kept: the next file asks again.
        if (!defaults) machineDefaultsRequest = undefined;
        return defaults;
      });
    return machineDefaultsRequest;
  },
  async prepare(file, classification) {
    const query = new URLSearchParams({ name: file.name || 'attachment', type: classification.mimeType });
    const response = await fetch(`/api/chat/attachments?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (isPrepared(body)) return body;
    throw new Error(`Attachment preparation answered ${response.status}`);
  },
};

/** Saved settings applied to this computer's defaults; small safe defaults if the server does not answer. */
export async function resolveIntakeLimits(
  settings: ChatAttachmentSettings | undefined,
  server: IntakeServer = httpIntakeServer,
): Promise<ChatAttachmentLimits> {
  const defaults = await server.machineDefaults().catch(() => undefined) ?? {
    defaultMaxFileBytes: FALLBACK_CHAT_ATTACHMENT_LIMITS.maxFileBytes,
    maxInlineBytes: FALLBACK_CHAT_ATTACHMENT_LIMITS.maxInlineBytes,
  };
  return resolveChatAttachmentLimits(settings, defaults);
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Failed to encode file')));
    reader.onerror = () => reject(reader.error ?? new Error('Error reading file'));
    reader.readAsDataURL(file);
  });
}

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Failed to read file')));
    reader.onerror = () => reject(reader.error ?? new Error('Error reading file'));
    reader.readAsText(file);
  });
}

function readBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (reader.result instanceof ArrayBuffer ? resolve(new Uint8Array(reader.result)) : reject(new Error('Failed to read file')));
    reader.onerror = () => reject(reader.error ?? new Error('Error reading file'));
    reader.readAsArrayBuffer(file);
  });
}

function displayName(file: File, classification: AttachmentClassification): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const extension = classification.mimeType.split('/')[1]?.split('+')[0] || 'bin';
  return classification.family === 'image' ? `Pasted image.${extension}` : file.name || `Pasted file.${extension}`;
}

/** A chip shown while the file is read; it is replaced by the finished attachment. */
export function pendingAttachment(file: File): Attachment {
  const classification = classifyAttachment(file.name, file.type);
  return {
    id: uuidv4(),
    type: 'document',
    content: '',
    originalName: displayName(file, classification),
    mimeType: classification.mimeType,
    size: file.size,
    format: classification.format,
    ...(classification.language ? { language: classification.language } : {}),
    pending: true,
  };
}

async function asText(file: File, base: Attachment, limits: ChatAttachmentLimits): Promise<Attachment | undefined> {
  if (!looksLikeText(await readBytes(file.slice(0, 4096)))) return undefined;
  const text = await readText(file);
  const kept = text.slice(0, limits.maxTextCharacters);
  return {
    ...base,
    type: 'document',
    content: kept,
    note: {
      code: 'text',
      ...(kept.length < text.length ? { shortened: { unit: 'character' as const, kept: kept.length, total: text.length } } : {}),
    },
  };
}

function noteOnly(base: Attachment, note: AttachmentNote): Attachment {
  return { ...base, type: 'document', content: '', note };
}

async function fromServer(file: File, base: Attachment, classification: AttachmentClassification, server: IntakeServer): Promise<Attachment> {
  const prepared = await server.prepare(file, classification);
  switch (prepared.kind) {
    case 'text':
      return { ...base, type: 'document', content: prepared.text, note: prepared.note };
    case 'image':
      return { ...base, type: 'image', content: prepared.dataUrl, mimeType: prepared.mimeType, note: prepared.note };
    case 'pdf':
      return { ...base, type: 'document', content: await readDataUrl(file), mimeType: 'application/pdf', note: prepared.note };
    default:
      return noteOnly(base, prepared.note);
  }
}

/** Read or convert one file. Never throws: a problem becomes a note on the chip. */
export async function fileToAttachment(
  file: File,
  limits: ChatAttachmentLimits,
  server: IntakeServer = httpIntakeServer,
  pending: Attachment = pendingAttachment(file),
): Promise<Attachment> {
  const classification = classifyAttachment(file.name, file.type);
  const { pending: _pending, ...base } = pending;
  try {
    if (file.size > limits.maxFileBytes) return noteOnly(base, { code: 'too-large', values: { limit: limits.maxFileBytes } });
    switch (classification.family) {
      case 'text':
        return await asText(file, base, limits) ?? noteOnly(base, { code: 'name-only' });
      case 'image':
        if (file.size > limits.maxInlineBytes) return await fromServer(file, base, classification, server);
        return { ...base, type: 'image', content: await readDataUrl(file), note: { code: 'image' } };
      case 'audio':
      case 'video':
        if (file.size > limits.maxInlineBytes) return noteOnly(base, { code: 'too-large-to-send', values: { limit: limits.maxInlineBytes } });
        return { ...base, type: classification.family, content: await readDataUrl(file), note: { code: classification.family } };
      case 'binary':
        // Unknown extensions are often plain text (config files, logs, notes).
        return await asText(file, { ...base, format: 'Text' }, limits) ?? noteOnly(base, { code: 'name-only' });
      default:
        return await fromServer(file, base, classification, server);
    }
  } catch (error) {
    log.warn(`Could not read attachment ${file.name || '(unnamed)'}`, error);
    return noteOnly(base, { code: 'failed' });
  }
}

/** Prepare files a few at a time so dropping a folder's worth does not flood the server. */
export async function filesToAttachments(
  files: File[],
  limits: ChatAttachmentLimits,
  onReady: (pendingId: string, attachment: Attachment) => void,
  server: IntakeServer = httpIntakeServer,
  pendings: Attachment[] = files.map(pendingAttachment),
  concurrency = 3,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      onReady(pendings[index].id, await fileToAttachment(files[index], limits, server, pendings[index]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}
