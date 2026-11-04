/**
 * Per-workspace switches for the ways to talk to a model without a saved flow.
 *
 * A workspace may want every model conversation to pass through a flow, so that the
 * flow's checks apply. Both switches default to on, which keeps existing installs
 * unchanged. Settings live in workspace storage, so each workspace decides for itself.
 */
import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';

export const DIRECT_MODEL_CALLS_DISABLED_CODE = 'direct_model_calls_disabled';
export const DIRECT_MODEL_CALLS_DISABLED_MESSAGE =
  'Direct model calls are switched off in this workspace. Use a flow instead, or change this in Settings.';

export const QUICK_CHAT_DISABLED_CODE = 'quick_chat_disabled';
export const QUICK_CHAT_DISABLED_MESSAGE =
  'Quick Chat is switched off in this workspace. Use a flow instead, or change this in Settings.';

async function loadModelAccess(): Promise<Settings['modelAccess']> {
  const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
  return settings?.modelAccess;
}

/** Whether `model-<id>` and `policy/<id>` calls and listings are allowed here. */
export async function isDirectModelCallsEnabled(): Promise<boolean> {
  return (await loadModelAccess())?.directModelCalls !== false;
}

/** Whether Quick Chat and the features built on it are allowed here. */
export async function isQuickChatEnabled(): Promise<boolean> {
  return (await loadModelAccess())?.quickChat !== false;
}
