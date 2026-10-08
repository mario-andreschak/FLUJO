import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { readStableFile } from '@/utils/readStableFile';
import { admitCodexDirectory, readCodexRuntimeFile, writeCodexRuntimeFile } from './codexRuntimeFiles';

export const CODEX_AUTH_SOURCE_FILE = 'flujo-auth-source.json';
export const WORKSPACE_CODEX_AUTH_SOURCE = { version: 1, source: 'workspace' } as const;

interface AuthSource {
  version: 1;
  source: 'host' | 'workspace';
  sourceHash?: string;
}

export class CodexAuthInspectionError extends Error {
  constructor(readonly reasonCode: 'credential-store-unreadable' | 'credential-store-incompatible' | 'auth-source-unreadable' | 'login-missing' | 'login-incompatible', message: string) {
    super(message);
    this.name = 'CodexAuthInspectionError';
  }
}

export function userCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/**
 * A leftover auth.json is not authoritative when the host selected its OS store.
 * FLUJO uses the unprofiled host login. Codex >=0.134 selects profile files only
 * through --profile; overrides passed to another process cannot be inferred here.
 */
async function assertFileBackedHostAuth(home: string): Promise<void> {
  const file = path.join(home, 'config.toml');
  let config: Record<string, unknown>;
  let found = false;
  try {
    const link = await fs.lstat(file);
    found = true;
    if (!link.isFile() && !link.isSymbolicLink()) throw new Error();
    const content = await readStableFile(file, 1024 * 1024, { allowSymbolicLink: true });
    config = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } catch (error) {
    if (!found && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // TOML errors can contain entire source lines, including unrelated secrets.
    throw new CodexAuthInspectionError('credential-store-unreadable', 'Could not verify the host Codex credential store. Repair or make its config.toml readable before using its login in FLUJO.');
  }
  const store = config.cli_auth_credentials_store;
  if (store !== undefined && store !== 'file') {
    throw new CodexAuthInspectionError('credential-store-incompatible', 'FLUJO requires file-backed Codex authentication. Configure cli_auth_credentials_store = "file" and sign in again; keyring and auto storage cannot identify the active login from auth.json.');
  }
}

async function authSource(home: string, existingGuard?: () => Promise<void>): Promise<AuthSource | undefined> {
  try {
    const guard = existingGuard ?? await admitCodexDirectory(home);
    const value = JSON.parse((await readCodexRuntimeFile(home, path.join(home, CODEX_AUTH_SOURCE_FILE), 4096, guard)).toString('utf8'));
    if (value?.version !== 1 || !['host', 'workspace'].includes(value.source)) {
      throw new Error('Invalid FLUJO Codex authentication source.');
    }
    return value as AuthSource;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // JSON parser messages may contain credential-adjacent file content.
    throw new CodexAuthInspectionError('auth-source-unreadable', 'Could not read FLUJO Codex authentication source.');
  }
}

/** Keep child refreshes unless the operator actually changes the host login. */
export async function synchronizeCodexAuth(home: string): Promise<void> {
  const guard = await admitCodexDirectory(home);
  const state = await authSource(home, guard);
  const destination = path.join(home, 'auth.json');
  if (state?.source === 'workspace') {
    // A restored worker owns this credential. A missing host login is expected.
    await readCodexRuntimeFile(home, destination, 1024 * 1024, guard).catch(() => {
      throw new Error('The worker Codex login is missing. Sign in using its CODEX_HOME.');
    });
    return;
  }
  const hostHome = userCodexHome();
  await assertFileBackedHostAuth(hostHome);
  const source = path.join(hostHome, 'auth.json');
  if (path.resolve(source) === path.resolve(destination)) return;
  let content: Buffer;
  try {
    content = await readStableFile(source, 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Could not read the host Codex login.');
    }
    // Preserve the existing explicit logout behavior for host-backed workspaces.
    await guard();
    await fs.rm(destination, { force: true });
    await fs.rm(path.join(home, CODEX_AUTH_SOURCE_FILE), { force: true });
    return;
  }
  const sourceHash = createHash('sha256').update(content).digest('hex');
  const destinationExists = await readCodexRuntimeFile(home, destination, 1024 * 1024, guard).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (state?.sourceHash === sourceHash && destinationExists) return;
  await writeCodexRuntimeFile(home, destination, content, guard);
  await writeCodexRuntimeFile(home, path.join(home, CODEX_AUTH_SOURCE_FILE), JSON.stringify({
    version: 1, source: 'host', sourceHash,
  } satisfies AuthSource), guard);
}

export function isChatGptAuthCache(content: Buffer): boolean {
  try {
    const auth = JSON.parse(content.toString('utf8'));
    return (!auth.auth_mode || auth.auth_mode === 'chatgpt')
      && !auth.OPENAI_API_KEY
      && typeof auth.tokens?.access_token === 'string'
      && auth.tokens.access_token.length > 0
      && typeof auth.tokens?.refresh_token === 'string'
      && auth.tokens.refresh_token.length > 0;
  } catch {
    return false;
  }
}

/** Read the current authoritative login, without changing the live workspace. */
export async function readCodexAuthForTransfer(workspace?: string): Promise<Buffer> {
  const home = path.join(getWorkspaceDataDir(workspace), 'db', 'codex-runtime');
  let guard: (() => Promise<void>) | undefined;
  try { guard = await admitCodexDirectory(home); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexAuthInspectionError('auth-source-unreadable', 'Could not read FLUJO Codex authentication source.');
  }
  const state = await authSource(home, guard);
  const sourceHome = state?.source === 'workspace' ? home : userCodexHome();
  if (state?.source !== 'workspace') await assertFileBackedHostAuth(sourceHome);
  let source = path.join(sourceHome, 'auth.json');
  if (state?.source === 'host' && state.sourceHash) {
    // A child may have rotated its tokens since the host cache was last seeded.
    // Reuse that cache only while the host still represents the same login.
    const host = await readStableFile(source, 1024 * 1024).catch(() => undefined);
    if (host && createHash('sha256').update(host).digest('hex') === state.sourceHash) {
      const child = path.join(home, 'auth.json');
      try {
        if (!guard) throw new Error('Managed Codex home is unavailable.');
        await readCodexRuntimeFile(home, child, 1024 * 1024, guard);
        source = child;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexAuthInspectionError('auth-source-unreadable', 'Could not read FLUJO Codex authentication source.');
      }
    }
  }
  let content: Buffer;
  try {
    content = source === path.join(home, 'auth.json')
      ? await readCodexRuntimeFile(home, source, 1024 * 1024, guard ?? await admitCodexDirectory(home))
      : await readStableFile(source, 1024 * 1024);
  } catch {
    throw new CodexAuthInspectionError('login-missing', 'A file-backed Codex ChatGPT login is required. Sign in with Codex using file credential storage before cloning.');
  }
  if (!isChatGptAuthCache(content)) {
    throw new CodexAuthInspectionError('login-incompatible', 'The Codex authentication cache is not a transferable ChatGPT login.');
  }
  return content;
}

/** Passive discovery uses the same authoritative source as execution/transfer.
 * Never prepare a runtime home, copy credentials, refresh tokens, or return them. */
export async function inspectCodexLogin(workspace?: string): Promise<{
  authentication: 'login-detected' | 'needs-connection' | 'incompatible' | 'unknown';
  reasonCode?: string;
}> {
  try {
    await readCodexAuthForTransfer(workspace);
    return { authentication: 'login-detected' };
  } catch (error) {
    if (!(error instanceof CodexAuthInspectionError)) return { authentication: 'unknown', reasonCode: 'inspection-unavailable' };
    return {
      authentication: error.reasonCode === 'login-missing' ? 'needs-connection'
        : ['credential-store-incompatible', 'login-incompatible'].includes(error.reasonCode) ? 'incompatible' : 'unknown',
      reasonCode: error.reasonCode,
    };
  }
}
