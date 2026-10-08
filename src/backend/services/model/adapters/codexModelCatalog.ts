import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { loadItem } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { Settings } from '@/shared/types/storage/storage';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { readStableFile } from '@/utils/readStableFile';

const log = createLogger('backend/services/model/adapters/codexModelCatalog');

// Codex Desktop may refresh ~/.codex/models_cache.json with a schema that an
// older bundled CLI cannot deserialize. Keep this in lockstep with the
// @openai/codex-sdk version in package.json and only reuse catalogs produced by
// the same CLI compatibility line.
const CODEX_CATALOG_COMPATIBILITY_LINE = '0.153.';
// Match the existing verified private-profile catalog budget. Never allocate an
// unbounded operator-controlled cache while preparing a model invocation.
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_PREFIX = 'codex-model-catalog-';

export interface CodexModelCatalogSnapshot {
  path: string;
  cleanup: () => Promise<void>;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Codex run cancelled by user.');
}

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
 * Own a verified local model catalog for one invocation when explicitly enabled.
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
 * Stable operator-selected symlinks remain supported. The SDK receives a fresh
 * copy of exactly the validated bytes; refreshing the source cannot change a
 * later CLI startup. The caller must retain it until all SDK turns terminate.
 * Directory permissions protect it on POSIX; Windows inherits the workspace's
 * ACL. Neither protects against a writer already authorized as this OS user.
 */
export async function prepareCodexModelCatalogSnapshot(
  signal?: AbortSignal,
): Promise<CodexModelCatalogSnapshot | undefined> {
  assertNotCancelled(signal);
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    assertNotCancelled(signal);
    if (settings?.experimental?.codexModelCatalogCache !== true) return undefined;
  } catch (err) {
    assertNotCancelled(signal);
    log.warn('Failed to read codexModelCatalogCache setting; defaulting to disabled', { err });
    return undefined;
  }

  const configuredHome = process.env.CODEX_HOME?.trim();
  const codexHome = configuredHome || path.join(os.homedir(), '.codex');
  const catalogPath = path.join(codexHome, 'models_cache.json');

  let contents: Buffer;
  try {
    contents = await readStableFile(catalogPath, MAX_CATALOG_BYTES, { allowSymbolicLink: true });
    assertNotCancelled(signal);
    if (!isCompatibleCatalog(JSON.parse(contents.toString('utf8')))) return undefined;
  } catch {
    assertNotCancelled(signal);
    return undefined;
  }

  const parent = path.resolve(getWorkspaceDataDir(), 'db');
  let directory: string | undefined;
  const cleanup = async () => {
    if (!directory) return;
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith(SNAPSHOT_PREFIX)) {
      throw new Error('Codex model catalog cleanup target is outside its runtime directory.');
    }
    await fs.rm(target, { recursive: true, force: true });
  };
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    assertNotCancelled(signal);
    directory = await fs.mkdtemp(path.join(parent, SNAPSHOT_PREFIX));
    if (path.dirname(path.resolve(directory)) !== parent
      || !path.basename(directory).startsWith(SNAPSHOT_PREFIX)) {
      throw new Error('Codex model catalog snapshot directory is outside its runtime directory.');
    }
    assertNotCancelled(signal);
    // Apply restrictive POSIX permissions before publishing any file. On
    // Windows this does not establish a new ACL; the workspace must be owned.
    await fs.chmod(directory, 0o700);
    assertNotCancelled(signal);
    const snapshotPath = path.join(directory, 'models_cache.json');
    await fs.writeFile(snapshotPath, contents, { flag: 'wx', mode: 0o600 });
    assertNotCancelled(signal);
    const published = await readStableFile(snapshotPath, MAX_CATALOG_BYTES);
    if (!published.equals(contents)) throw new Error('Codex model catalog snapshot verification failed.');
    assertNotCancelled(signal);
    return { path: snapshotPath, cleanup };
  } catch {
    await cleanup().catch(() => log.warn('Failed to remove Codex model catalog snapshot'));
    assertNotCancelled(signal);
    return undefined;
  }
}
