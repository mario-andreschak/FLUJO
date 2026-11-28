import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { loadItem } from '@/utils/storage/backend';

/**
 * Whether tool servers wait for first use instead of starting with FLUJO.
 * The Settings page decides; eager stays the default: see
 * docs/features/mcp-lifecycle-hardening.md.
 */
export async function resolveLazyStart(): Promise<boolean> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    return settings?.mcp?.lazyStart === true;
  } catch {
    return false;
  }
}
