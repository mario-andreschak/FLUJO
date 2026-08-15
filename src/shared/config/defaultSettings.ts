import type { Settings } from '@/shared/types/storage/storage';

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
    experimental: {
      enabled: true,
      claudeSessionResume: true,
      autoUnloadOllamaModels: true,
      compactionEnabled: true,
      subflowDetachedInvocation: true,
      subflowSessions: true,
    },
  };
}
