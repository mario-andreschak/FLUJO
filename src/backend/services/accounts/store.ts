import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ACCOUNTS_BACKUP_FILE, ACCOUNTS_DIRECTORY, ACCOUNTS_FILE, ACCOUNTS_SCHEMA_VERSION, AUDIT_FILE, AUDIT_ROTATE_BYTES,
  SESSIONS_FILE, accountsFileSchema, auditEventSchema, sessionsFileSchema,
  type AccountsFile, type AuditEvent, type SessionsFile,
} from '@/shared/types/accounts';
import { getDataDir } from '@/utils/paths';
import { createLogger } from '@/utils/logger';
import { replaceFileWithRetry, retryTransientFileOperation } from '@/utils/transientFileRetry';

const log = createLogger('backend/services/accounts/store');

/**
 * Reads and writes `<data>/accounts/` (#574). The formats are fixed in
 * `src/shared/types/accounts.ts`; the rules in
 * `docs/architecture/multi-user-contracts.md`.
 *
 * Multi-user mode is opt-in. While `accounts.json` does not exist, the only
 * thing this module does is one `stat` that answers "missing": it reads,
 * creates and writes nothing.
 *
 * Every read checks the file's identity again, so a change made by the server
 * command line (`node bin/flujo.mjs users …`) or a restored file counts from
 * the next request on, without a restart. Writes go through one in-process
 * queue per file and replace the file atomically; `accounts.json.bak` holds
 * the last good copy and is used when the main file is damaged.
 */

export type AccountsState =
  /** No `accounts.json`: today's single-user FLUJO. */
  | { readonly mode: 'off'; readonly accounts: null }
  /** A valid file that says `"enabled": false`. Kept for turning the mode on again. */
  | { readonly mode: 'off'; readonly accounts: AccountsFile }
  | { readonly mode: 'on'; readonly accounts: AccountsFile }
  /** The file exists but neither it nor its `.bak` copy can be read. Nobody can sign in until it is fixed. */
  | { readonly mode: 'damaged'; readonly accounts: null };

export class AccountsDamagedError extends Error {
  readonly status = 503;
  constructor() {
    super('The accounts file is damaged. Restore accounts.json or run "node bin/flujo.mjs users off" on the server.');
    this.name = 'AccountsDamagedError';
  }
}

export class AccountsConflictError extends Error {
  readonly status = 409;
  constructor() {
    super('Someone else changed the accounts in the meantime. Reload the page and try again.');
    this.name = 'AccountsConflictError';
  }
}

export function accountsDirectory(): string {
  return path.join(getDataDir(), ACCOUNTS_DIRECTORY);
}

export function accountsFilePath(): string {
  return path.join(accountsDirectory(), ACCOUNTS_FILE);
}

function backupFilePath(): string {
  return path.join(accountsDirectory(), ACCOUNTS_BACKUP_FILE);
}

function sessionsFilePath(): string {
  return path.join(accountsDirectory(), SESSIONS_FILE);
}

function auditFilePath(): string {
  return path.join(accountsDirectory(), AUDIT_FILE);
}

interface CachedFile<T> {
  readonly file: string;
  readonly signature: string;
  readonly value: T;
  /** Set when the main file was damaged and the value came from the `.bak` copy: that copy's identity. */
  readonly backupSignature?: string | null;
}

interface StoreGlobals {
  accounts?: CachedFile<AccountsState>;
  sessions?: CachedFile<SessionsFile>;
  chains: Map<string, Promise<unknown>>;
  reportedBackup?: string;
}

declare global {
  var __flujo_accounts_store: StoreGlobals | undefined;
}

/** Shared by every bundle in the process (Next.js may load this module more than once, for example in the proxy). */
function globals(): StoreGlobals {
  global.__flujo_accounts_store ??= { chains: new Map() };
  return global.__flujo_accounts_store;
}

function signatureOf(stat: { ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function statOrNull(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? signatureOf(stat) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write a private file atomically: a temporary file next to it, flushed, then renamed over the target. */
export async function writePrivateFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFileWithRetry(temporary, file, { label: 'accounts-replace' });
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await retryTransientFileOperation(() => fs.readFile(file, 'utf8'), { label: 'accounts-read' }));
}

async function parseAccounts(file: string): Promise<AccountsFile | null> {
  try {
    return accountsFileSchema.parse(await readJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`Could not use ${path.basename(file)}`, error);
    return null;
  }
}

function stateOf(accounts: AccountsFile): AccountsState {
  return accounts.enabled ? { mode: 'on', accounts } : { mode: 'off', accounts };
}

async function readAccountsState(): Promise<{ state: AccountsState; fromBackup: boolean }> {
  const main = await parseAccounts(accountsFilePath());
  if (main) return { state: stateOf(main), fromBackup: false };
  const backup = await parseAccounts(backupFilePath());
  if (backup) {
    const shared = globals();
    const key = `${accountsFilePath()}#${backup.revision}`;
    if (shared.reportedBackup !== key) {
      shared.reportedBackup = key;
      log.error('accounts.json is damaged; using the last good copy accounts.json.bak until it is fixed.');
    }
    return { state: stateOf(backup), fromBackup: true };
  }
  log.error('accounts.json and accounts.json.bak are both damaged; sign-in is unavailable until one is restored.');
  return { state: { mode: 'damaged', accounts: null }, fromBackup: true };
}

/**
 * The current accounts state. With no `accounts.json` this costs one `stat`
 * and nothing else. Otherwise the parsed file is reused until the file changes.
 */
export async function loadAccountsState(): Promise<AccountsState> {
  const file = accountsFilePath();
  const signature = await statOrNull(file);
  if (signature === null) return { mode: 'off', accounts: null };
  const shared = globals();
  const cached = shared.accounts;
  if (cached?.file === file && cached.signature === signature
      && (cached.backupSignature === undefined || cached.backupSignature === await statOrNull(backupFilePath()))) {
    return cached.value;
  }
  const backupSignature = await statOrNull(backupFilePath());
  const { state, fromBackup } = await readAccountsState();
  shared.accounts = { file, signature, value: state, ...(fromBackup ? { backupSignature } : {}) };
  return state;
}

/** The parsed file when multi-user mode is on, `null` when it is off. Throws {@link AccountsDamagedError}. */
export async function loadEnabledAccounts(): Promise<AccountsFile | null> {
  const state = await loadAccountsState();
  if (state.mode === 'damaged') throw new AccountsDamagedError();
  return state.mode === 'on' ? state.accounts : null;
}

/** Run writes to one file one after another inside this process. */
function inChain<T>(key: string, task: () => Promise<T>): Promise<T> {
  const chains = globals().chains;
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  chains.set(key, run);
  void run.catch(() => undefined).finally(() => {
    if (chains.get(key) === run) chains.delete(key);
  });
  return run;
}

export interface AccountsMutation {
  /** Refuse the write when the file has moved on from this revision (another admin page saved first). */
  readonly expectedRevision?: number;
}

/**
 * Change `accounts.json`. `change` gets a copy of the current file (`null`
 * when there is none) and returns the next one. The revision goes up by one;
 * the result must pass `accountsFileSchema`, so a change can never leave a
 * file the server would refuse.
 */
export function mutateAccounts(change: (current: AccountsFile | null) => AccountsFile | Promise<AccountsFile>,
  options: AccountsMutation = {}): Promise<AccountsFile> {
  return inChain(`accounts:${accountsFilePath()}`, async () => {
    const file = accountsFilePath();
    const exists = (await statOrNull(file)) !== null || (await statOrNull(backupFilePath())) !== null;
    const state = exists ? (await readAccountsState()).state : { mode: 'off' as const, accounts: null };
    if (state.mode === 'damaged') throw new AccountsDamagedError();
    const current = state.accounts;
    if (options.expectedRevision !== undefined && (current?.revision ?? 0) !== options.expectedRevision) {
      throw new AccountsConflictError();
    }
    const draft = await change(current ? structuredClone(current) : null);
    const next = accountsFileSchema.parse({ ...draft, schemaVersion: ACCOUNTS_SCHEMA_VERSION, revision: (current?.revision ?? 0) + 1 });
    const text = `${JSON.stringify(next, null, 2)}\n`;
    await writePrivateFileAtomic(file, text);
    await writePrivateFileAtomic(backupFilePath(), text);
    const signature = await statOrNull(file);
    if (signature) globals().accounts = { file, signature, value: stateOf(next) };
    return next;
  });
}

const EMPTY_SESSIONS: SessionsFile = Object.freeze({ schemaVersion: ACCOUNTS_SCHEMA_VERSION, sessions: [] });

async function readSessionsFile(file: string): Promise<SessionsFile> {
  try {
    return sessionsFileSchema.parse(await readJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Losing sessions only means signing in again; the next write repairs the file.
      log.warn('sessions.json could not be read; everyone signs in again.', error);
    }
    return EMPTY_SESSIONS;
  }
}

/** The signed-in browser sessions. Reused until the file changes. */
export async function loadSessions(): Promise<SessionsFile> {
  const file = sessionsFilePath();
  const signature = await statOrNull(file);
  if (signature === null) return EMPTY_SESSIONS;
  const shared = globals();
  if (shared.sessions?.file === file && shared.sessions.signature === signature) return shared.sessions.value;
  const value = await readSessionsFile(file);
  shared.sessions = { file, signature, value };
  return value;
}

/** Change `sessions.json`. Expired sessions are dropped on every write. */
export function mutateSessions(change: (current: SessionsFile) => SessionsFile, now = Date.now()): Promise<SessionsFile> {
  return inChain(`sessions:${sessionsFilePath()}`, async () => {
    const file = sessionsFilePath();
    const current = await readSessionsFile(file);
    const changed = change(structuredClone(current));
    const next = sessionsFileSchema.parse({
      schemaVersion: ACCOUNTS_SCHEMA_VERSION,
      sessions: changed.sessions.filter(session => session.expiresAt > now),
    });
    await writePrivateFileAtomic(file, `${JSON.stringify(next)}\n`);
    const signature = await statOrNull(file);
    if (signature) globals().sessions = { file, signature, value: next };
    return next;
  });
}

/**
 * Add one line to `audit.jsonl`. Never throws and never refuses because the
 * log is big: past 10 MiB the file moves to `audit.1.jsonl` and a new one starts.
 */
export function appendAudit(event: Omit<AuditEvent, 'at'> & { at?: number }): Promise<void> {
  return inChain(`audit:${auditFilePath()}`, async () => {
    try {
      const line = `${JSON.stringify(auditEventSchema.parse({ ...event, at: event.at ?? Date.now() }))}\n`;
      const file = auditFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const size = await fs.stat(file).then(stat => stat.size, () => 0);
      if (size + line.length > AUDIT_ROTATE_BYTES) {
        await replaceFileWithRetry(file, path.join(path.dirname(file), 'audit.1.jsonl'), { label: 'accounts-audit-rotate' });
      }
      await retryTransientFileOperation(() => fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 }), { label: 'accounts-audit-append' });
    } catch (error) {
      log.warn('Could not write the accounts audit log', error);
    }
  });
}

/** Forget cached files (tests, and after the data folder changes). */
export function resetAccountsStoreCache(): void {
  const shared = globals();
  shared.accounts = undefined;
  shared.sessions = undefined;
  shared.reportedBackup = undefined;
}
