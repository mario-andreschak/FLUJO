import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { loadItem } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { Settings } from '@/shared/types/storage/storage';

const log = createLogger('backend/services/model/adapters/codexModelCatalog');

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
    return stat.isFile() ? catalogPath : undefined;
  } catch {
    return undefined;
  }
}
