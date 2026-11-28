import type { Settings } from '@/shared/types/storage/storage';
import { PINNED_EXPERIMENTAL_SETTINGS } from './retiredSettings';

/**
 * Settings written for a brand-new FLUJO installation.
 *
 * Keep this as a factory so React state and persisted storage never share a
 * mutable object instance.
 */
export function createDefaultSettings(): Settings {
  return {
    speech: { enabled: true },
    update: { checkOnStartup: false },
    experimental: { ...PINNED_EXPERIMENTAL_SETTINGS },
  };
}
