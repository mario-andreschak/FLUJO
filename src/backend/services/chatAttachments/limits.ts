import os from 'node:os';
import { getRunInputLimitBytes } from '@/backend/execution/flow/runAdmission';
import {
  defaultMaxFileBytes,
  inlineBytesForRunInputLimit,
  resolveChatAttachmentLimits,
  type ChatAttachmentLimits,
} from '@/shared/chatAttachments/limits';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { loadItem } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/chatAttachments/limits');

export function machineAttachmentDefaults(): { defaultMaxFileBytes: number; maxInlineBytes: number } {
  return {
    defaultMaxFileBytes: defaultMaxFileBytes(os.totalmem()),
    maxInlineBytes: inlineBytesForRunInputLimit(getRunInputLimitBytes()),
  };
}

/** The limits in force now: saved settings, or defaults that follow this computer. */
export async function currentChatAttachmentLimits(): Promise<ChatAttachmentLimits> {
  let settings: Settings | undefined;
  try {
    settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
  } catch (error) {
    log.warn('Could not read chat attachment settings; using defaults', error);
  }
  return resolveChatAttachmentLimits(settings?.chatAttachments, machineAttachmentDefaults());
}

/** Largest XML part or archive member unpacked while extracting text. */
export function maxPartBytes(limits: ChatAttachmentLimits): number {
  return Math.min(256 * 1024 * 1024, Math.max(16 * 1024 * 1024, limits.maxTextCharacters * 16));
}
