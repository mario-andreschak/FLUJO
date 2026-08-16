import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { loadItem } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { Settings } from '@/shared/types/storage/storage';

const log = createLogger('backend/services/model/adapters/codexModelCatalog');

// Codex Desktop may refresh ~/.codex/models_cache.json with a schema that an
// older bundled CLI cannot deserialize. Keep this in lockstep with the
// @openai/codex-sdk version in package.json and only reuse catalogs produced by
// the same CLI compatibility line.
const CODEX_CATALOG_COMPATIBILITY_LINE = '0.147.';

type CodexCatalog = {
  client_version?: unknown;
  models?: unknown;
};

function isCompatibleCatalog(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const catalog = value as CodexCatalog;
  if (
    typeof catalog.client_version !== 'string'
    || !catalog.client_version.startsWith(CODEX_CATALOG_COMPATIBILITY_LINE)
    || !Array.isArray(catalog.models)
    || catalog.models.length === 0
  ) {
    return false;
  }

  return catalog.models.every((model) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
    const entry = model as Record<string, unknown>;
    return typeof entry.slug === 'string'
      && Boolean(entry.model_messages)
      && typeof entry.model_messages === 'object'
      && !Array.isArray(entry.model_messages);
  });
}

/**
 * Resolve Codex's last known-good local model catalog when explicitly enabled.
 *
 * Codex CLI currently refreshes the remote catalog during `exec`; on some
 * machines that refresh's helper process times out and aborts an otherwise
 * healthy authenticated run. `model_catalog_json` is Codex's supported
 * startup-only override and avoids that network refresh while retaining the
 * catalog maintained by the user's normal Codex installation.
 *
 * The local cache can also be incompatible with the Codex version bundled by
 * FLUJO, so this workaround is experimental and defaults to off. Settings read
 * failures fail closed and preserve Codex's normal catalogue behaviour.
 */
export async function resolveCodexModelCatalogPath(): Promise<string | undefined> {
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    if (settings?.experimental?.codexModelCatalogCache !== true) return undefined;
  } catch (err) {
    log.warn('Failed to read codexModelCatalogCache setting; defaulting to disabled', { err });
    return undefined;
  }

  const configuredHome = process.env.CODEX_HOME?.trim();
  const codexHome = configuredHome || path.join(os.homedir(), '.codex');
  const catalogPath = path.join(codexHome, 'models_cache.json');

  try {
    const stat = await fs.stat(catalogPath);
    if (!stat.isFile()) return undefined;

    const contents = await fs.readFile(catalogPath, 'utf8');
    return isCompatibleCatalog(JSON.parse(contents)) ? catalogPath : undefined;
  } catch {
    return undefined;
  }
}
