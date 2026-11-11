import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { loadItem } from '@/utils/storage/backend';

/**
 * Whether tool servers wait for first use instead of starting with FLUJO.
 *
 * `FLUJO_MCP_LAZY_START`, when set, wins so existing launch scripts keep working.
 * Otherwise the Settings page decides. Eager stays the default: see
 * docs/features/mcp-lifecycle-hardening.md.
 */
export async function resolveLazyStart(): Promise<boolean> {
  const fromEnvironment = process.env.FLUJO_MCP_LAZY_START?.trim();
  if (fromEnvironment) return /^(1|true|yes)$/i.test(fromEnvironment);
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    return settings?.mcp?.lazyStart === true;
  } catch {
    return false;
  }
}
