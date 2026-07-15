/**
 * Settings for the MCP-server quality layer: which providers are enabled, their
 * blend weights, the headless works-gate, and an optional GitHub token.
 *
 * Mirrors the load/save/normalize idiom of `@/backend/services/mcp/autoInstall`
 * (SEP-1024 settings). Normalization is defensive: stored provider entries are
 * merged OVER the code defaults keyed by id, so adding a provider in code needs
 * no stored-settings migration and removing one drops its stale entry.
 *
 * SECRETS: `githubToken` is a credential. Never return it to the frontend — any
 * API handler that echoes settings to the browser must go through
 * `toPublicQualitySettings()`.
 */
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { PROVIDERS } from './providers';

const log = createLogger('backend/services/mcp/quality/settings');

export interface QualityProviderSetting {
  id: string;
  enabled: boolean;
  /** Blend weight (relative, need not sum to 1 — the scorer normalizes). */
  weight: number;
}

export interface McpQualitySettings {
  providers: QualityProviderSetting[];
  /**
   * Headless minimum composite score (0..1) a candidate must reach to be
   * auto-installed. 0 = don't filter on score (ranking + works-gate still apply).
   */
  minScore: number;
  /**
   * When true, headless install walks best→worst and rejects a candidate that
   * fails to boot or reports zero tools, trying the next one. Default true.
   */
  worksGate: boolean;
  /** Optional GitHub token to lift the API rate limit. SECRET — never to frontend. */
  githubToken?: string;
}

/** Code-default provider settings, derived from the registered providers. */
function defaultProviderSettings(): QualityProviderSetting[] {
  return PROVIDERS.map((p) => ({ id: p.id, enabled: true, weight: p.defaultWeight }));
}

export function defaultQualitySettings(): McpQualitySettings {
  return {
    providers: defaultProviderSettings(),
    minScore: 0,
    worksGate: true,
  };
}

function clamp01(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Coerce a possibly-partial/untrusted stored blob into complete, valid settings. */
export function normalizeQualitySettings(
  raw: Partial<McpQualitySettings> | null | undefined
): McpQualitySettings {
  const defaults = defaultQualitySettings();
  const r = raw ?? {};

  // Merge stored provider entries over the code defaults, keyed by id. Only ids
  // that still exist in code survive; providers absent from storage get defaults.
  const storedById = new Map<string, Partial<QualityProviderSetting>>();
  if (Array.isArray(r.providers)) {
    for (const p of r.providers) {
      if (p && typeof p.id === 'string') storedById.set(p.id, p);
    }
  }
  const providers = defaults.providers.map((def) => {
    const stored = storedById.get(def.id);
    return {
      id: def.id,
      enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : def.enabled,
      weight:
        typeof stored?.weight === 'number' && Number.isFinite(stored.weight) && stored.weight >= 0
          ? stored.weight
          : def.weight,
    };
  });

  return {
    providers,
    minScore: clamp01(r.minScore, defaults.minScore),
    worksGate: typeof r.worksGate === 'boolean' ? r.worksGate : defaults.worksGate,
    ...(typeof r.githubToken === 'string' && r.githubToken.length > 0
      ? { githubToken: r.githubToken }
      : {}),
  };
}

export async function loadQualitySettings(): Promise<McpQualitySettings> {
  try {
    const raw = await loadItem<Partial<McpQualitySettings>>(
      StorageKey.MCP_QUALITY_SETTINGS,
      defaultQualitySettings()
    );
    return normalizeQualitySettings(raw);
  } catch (error) {
    log.warn('Failed to load mcpQuality settings; using defaults', error);
    return defaultQualitySettings();
  }
}

export async function saveQualitySettings(settings: McpQualitySettings): Promise<void> {
  await saveItem(StorageKey.MCP_QUALITY_SETTINGS, normalizeQualitySettings(settings));
}

/** Strip the GitHub token (and any future secret) before sending to the frontend. */
export function toPublicQualitySettings(
  settings: McpQualitySettings
): Omit<McpQualitySettings, 'githubToken'> & { githubTokenSet: boolean } {
  const { githubToken, ...rest } = settings;
  return { ...rest, githubTokenSet: Boolean(githubToken) };
}

/** Resolve the effective weight for a provider id from settings (else 0 if disabled/missing). */
export function effectiveWeight(settings: McpQualitySettings, providerId: string): number {
  const p = settings.providers.find((x) => x.id === providerId);
  if (!p || !p.enabled) return 0;
  return p.weight;
}

/** Whether a provider id is enabled per settings. */
export function isProviderEnabled(settings: McpQualitySettings, providerId: string): boolean {
  const p = settings.providers.find((x) => x.id === providerId);
  return Boolean(p?.enabled);
}
