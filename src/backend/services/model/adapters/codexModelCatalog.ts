import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

/**
 * Prefer Codex's last known-good local model catalog.
 *
 * Codex CLI currently refreshes the remote catalog during `exec`; on some
 * machines that refresh's helper process times out and aborts an otherwise
 * healthy authenticated run. `model_catalog_json` is Codex's supported
 * startup-only override and avoids that network refresh while retaining the
 * catalog maintained by the user's normal Codex installation.
 */
export async function resolveCodexModelCatalogPath(): Promise<string | undefined> {
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
