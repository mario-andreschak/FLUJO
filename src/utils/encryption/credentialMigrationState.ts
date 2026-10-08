import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';

export const MIGRATION_PENDING_FILE = '.credential-migration.pending';
export const CREDENTIAL_STORE_NAMES = ['models', 'mcp_servers', 'global_env_vars', 'registry_account', 'encryption_key'] as const;
export class CredentialMigrationPendingError extends Error {
  constructor() { super('Credential migration is pending. Resume or roll back using its recovery passphrase.'); this.name = 'CredentialMigrationPendingError'; }
}
export function credentialMigrationPath(workspace?: string) { return path.join(getWorkspaceDataDir(workspace), 'db', MIGRATION_PENDING_FILE); }
/** Any marker or unreadable state is closed; only authoritative ENOENT is open. */
export async function isCredentialMigrationPending(workspace?: string): Promise<boolean> {
  try { await fs.lstat(credentialMigrationPath(workspace)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
export async function assertCredentialMigrationReady() {
  if (await isCredentialMigrationPending()) throw new CredentialMigrationPendingError();
}
export async function assertCredentialStoreReady(file: string) {
  const basename = path.basename(file);
  if (CREDENTIAL_STORE_NAMES.some(key => basename === `${key}.json`)) await assertCredentialMigrationReady();
}
