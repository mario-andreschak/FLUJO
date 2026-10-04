import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { isSecretEnvVar } from '@/utils/shared/common';
import { readStableFile } from '@/utils/readStableFile';

/** Bounded strict read, without generic storage's parser logging/corrupt copies. */
export async function readCredentialJson(file: string, limit: number): Promise<unknown> {
  try {
    try {
      await fs.lstat(file, { bigint: true });
    } catch (error) {
      // Only initial absence is a missing record. Disappearance during a read is invalid storage.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const bytes = await readStableFile(file, limit);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Credential storage is invalid; restore a matching workspace backup');
  }
}

const CREDENTIAL_FIELDS = new Set(['apiKey', 'accessToken', 'refreshToken', 'access_token', 'refresh_token',
  'client_secret', 'oauthClientSecret', 'oauthCodeVerifier', 'authorization', 'Authorization', 'password']);

function hasCredentials(value: unknown): boolean {
  const queue: { value: unknown; depth: number; key?: string }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++visited > 32_768 || item.depth > 32) throw new Error('Credential inventory exceeds its limits');
    if (item.key && CREDENTIAL_FIELDS.has(item.key) && item.value !== '' && item.value != null) return true;
    if (typeof item.value === 'string' && /^(?:encrypted(?:_failed)?:|v2:|[a-f0-9]{32}:)/.test(item.value)) return true;
    if (item.value && typeof item.value === 'object') {
      const record = item.value as Record<string, unknown>;
      if (record.metadata && typeof record.metadata === 'object'
          && 'isSecret' in record.metadata && record.metadata.isSecret === true && record.value !== '') return true;
      for (const [key, child] of Object.entries(record)) queue.push({ value: child, key, depth: item.depth + 1 });
    }
  }
  return false;
}

/** Missing key metadata beside existing credentials is recovery, not fresh setup. */
export async function assertFreshEncryptionSetup(): Promise<void> {
  for (const name of ['models', 'registry_account', 'global_env_vars', 'mcp_servers']) {
    const value = await readCredentialJson(path.join(getWorkspaceDataDir(), 'db', `${name}.json`), 8 * 1024 * 1024);
    if (value === undefined) continue;
    if (!value || typeof value !== 'object') throw new Error('Credential storage requires explicit recovery');
    if (hasCredentials(value) || (name === 'global_env_vars'
        && Object.entries(value).some(([key, entry]) => typeof entry === 'string' && entry !== '' && isSecretEnvVar(key)))) {
      throw new Error('Existing credentials require migration or matching encryption metadata');
    }
  }
}
