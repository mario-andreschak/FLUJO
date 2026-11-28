/**
 * Switches that #1449 removed from Settings. Their features are on for
 * everyone and fall back by themselves, so a stored value is dropped when the
 * settings are read or saved.
 */
export const RETIRED_EXPERIMENTAL_SETTINGS = [
  'enabled',
  'harnessLabEnabled',
  'showModelsWithoutToolCapabilities',
  'flowBasedGenerator',
  'claudeWarmProcess',
  'codexModelCatalogCache',
  'subflowToolInvocation',
  'subflowDetachedInvocation',
  'subflowSessions',
  'mcpBetaProtocol',
  'mcpListCache',
  'lowLatencySaves',
  'mcpRuntimeHomeIsolation',
  'snapshotsEnabled',
  'compactionEnabled',
  'visualCompactionEnabled',
  'visualCompactionToolResultsOnly',
  'visualCompactionEvaluationMode',
  'claudeSessionResume',
  'autoUnloadOllamaModels',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return settings without retired switches; anything that is not a settings object passes through. */
export function withoutRetiredSettings<T>(settings: T): T {
  if (!isRecord(settings)) return settings;
  const experimental = isRecord(settings.experimental) ? { ...settings.experimental } : {};
  for (const name of RETIRED_EXPERIMENTAL_SETTINGS) delete experimental[name];
  return { ...settings, experimental } as T;
}
