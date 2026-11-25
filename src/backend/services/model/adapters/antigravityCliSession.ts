import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { readStableFile } from '@/utils/readStableFile';
import { computeHistoryHash } from './claudeSessionStore';
import { sessionValueHash } from './claudeSessionPersistence';
import { MESSAGE_NORMALIZATION_POLICY_VERSION } from './messageNormalization';
import type { AntigravityCliStats } from './antigravityCliEvents';

const log = createLogger('backend/services/model/adapters/antigravityCliSession');

/** Idle sessions are removed after a day, like Claude session checkpoints. */
export const ANTIGRAVITY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** A run ends within its five-minute deadline; older locks and homes belong to a crashed process. */
const STALE_LOCK_MS = 15 * 60 * 1000;
const STALE_INVOCATION_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export type AntigravitySessionUsage = AntigravityCliStats & { num_turns?: number };

export interface AntigravitySessionRecord {
  version: 1;
  /** The native CLI conversation that already holds this history. */
  conversationId: string;
  /** System prompt, tools, model and credential the conversation was built with. */
  prefixHash: string;
  /** Messages the native conversation reflects: the run input plus its transcript. */
  seenMessageCount: number;
  leadingSystemMessageCount: number;
  historyHash: string;
  /** Cumulative counters of the last result; a resumed result reports the whole conversation. */
  usage?: AntigravitySessionUsage;
  updatedAt: number;
}

export interface AntigravityResume {
  conversationId: string;
  delta: OpenAI.ChatCompletionMessageParam[];
  baseline?: AntigravitySessionUsage;
}

export interface AntigravitySession {
  home: string;
  record?: AntigravitySessionRecord;
  /** Drop the checkpoint before the native conversation changes, so a crash starts fresh. */
  forget(): Promise<void>;
  /** Empty the home before a new native conversation starts in it. */
  reset(): Promise<void>;
  save(record: Omit<AntigravitySessionRecord, 'version' | 'updatedAt'>): Promise<void>;
  release(): Promise<void>;
}

export function antigravityRuntimeRoot(): string {
  return path.resolve(getWorkspaceDataDir(), 'db', 'antigravity-cli-runtime');
}

export function antigravitySessionsRoot(): string {
  return path.join(antigravityRuntimeRoot(), 'sessions');
}

export function countLeadingSystemMessages(messages: readonly OpenAI.ChatCompletionMessageParam[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'system') break;
    count++;
  }
  return count;
}

export function antigravitySessionPrefix(value: Record<string, unknown>): string {
  return sessionValueHash({ scope: 'antigravity-session-v1', normalization: MESSAGE_NORMALIZATION_POLICY_VERSION, ...value });
}

export function antigravityHistoryHash(messages: readonly OpenAI.ChatCompletionMessageParam[], leadingSystems: number): string {
  return computeHistoryHash(messages.map(message => ({ ...message })), leadingSystems);
}

/** Resume only an unchanged prefix whose consumed history is still the start of this conversation. */
export function findAntigravityResume(
  record: AntigravitySessionRecord | undefined,
  current: { prefixHash: string; messages: readonly OpenAI.ChatCompletionMessageParam[]; leadingSystemMessageCount: number; now?: number },
): AntigravityResume | undefined {
  if (!record || record.prefixHash !== current.prefixHash) return undefined;
  if ((current.now ?? Date.now()) - record.updatedAt > ANTIGRAVITY_SESSION_TTL_MS) return undefined;
  if (record.leadingSystemMessageCount !== current.leadingSystemMessageCount) return undefined;
  if (current.messages.length <= record.seenMessageCount) return undefined;
  if (antigravityHistoryHash(current.messages.slice(0, record.seenMessageCount), current.leadingSystemMessageCount) !== record.historyHash) return undefined;
  return { conversationId: record.conversationId, delta: current.messages.slice(record.seenMessageCount), ...(record.usage ? { baseline: record.usage } : {}) };
}

function sessionId(conversationId: string, nodeId: string): string {
  return createHash('sha256').update(JSON.stringify(['antigravity-session-v1', conversationId, nodeId])).digest('hex').slice(0, 40);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseRecord(value: unknown): AntigravitySessionRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<AntigravitySessionRecord>;
  if (record.version !== 1 || typeof record.conversationId !== 'string' || !CONVERSATION_ID.test(record.conversationId)
    || typeof record.prefixHash !== 'string' || typeof record.historyHash !== 'string'
    || !isCount(record.seenMessageCount) || !isCount(record.leadingSystemMessageCount) || !isCount(record.updatedAt)) return undefined;
  const usage = record.usage && typeof record.usage === 'object'
    ? Object.fromEntries(Object.entries(record.usage).filter(([key, count]) =>
      ['input_tokens', 'output_tokens', 'cache_read_tokens', 'thinking_tokens', 'total_tokens', 'num_turns'].includes(key) && isCount(count)))
    : undefined;
  return { ...record, usage } as AntigravitySessionRecord;
}

async function readRecord(file: string): Promise<AntigravitySessionRecord | undefined> {
  try {
    return parseRecord(JSON.parse((await readStableFile(file, 64 * 1024)).toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Ignoring an unreadable Antigravity session checkpoint');
    return undefined;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const heldHere = new Set<string>();

async function lockIsStale(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) return true;
    const owner = JSON.parse((await readStableFile(file, 4096)).toString('utf8')) as { pid?: unknown };
    if (owner.pid === process.pid) return !heldHere.has(file);
    return !processAlive(owner.pid);
  } catch (error) {
    // A lock being written is younger than any crash; treat it as held.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function tryLock(file: string): Promise<boolean> {
  if (heldHere.has(file)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { await handle.close(); }
      heldHere.add(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!await lockIsStale(file)) return false;
      await fs.rm(file, { force: true });
    }
  }
  return false;
}

/**
 * Open the private home that keeps one FLUJO conversation node's native CLI
 * conversation between turns and restarts. Returns undefined when another run
 * holds it; the caller then replays the full history in a one-off home.
 */
export async function openAntigravitySession(conversationId: string, nodeId: string): Promise<AntigravitySession | undefined> {
  const root = antigravitySessionsRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  scheduleAntigravityRuntimeSweep();
  const id = sessionId(conversationId, nodeId);
  const home = path.join(root, id);
  const recordFile = path.join(root, `${id}.json`);
  const lockFile = path.join(root, `${id}.lock`);
  if (!await tryLock(lockFile)) return undefined;
  let released = false;
  try {
    const record = await readRecord(recordFile);
    return {
      home,
      record,
      forget: () => fs.rm(recordFile, { force: true }),
      reset: async () => {
        await fs.rm(home, { recursive: true, force: true });
        await fs.mkdir(home, { recursive: true, mode: 0o700 });
      },
      save: async record => {
        if (!CONVERSATION_ID.test(record.conversationId)) throw new Error('Invalid Antigravity conversation identity.');
        await writeAtomically(recordFile, JSON.stringify({ ...record, version: 1, updatedAt: Date.now() }));
      },
      release: async () => {
        if (released) return;
        released = true;
        heldHere.delete(lockFile);
        await fs.rm(lockFile, { force: true });
      },
    };
  } catch (error) {
    heldHere.delete(lockFile);
    await fs.rm(lockFile, { force: true });
    throw error;
  }
}

async function removeIfIdle(root: string, id: string, now: number): Promise<void> {
  const lockFile = path.join(root, `${id}.lock`);
  const recordFile = path.join(root, `${id}.json`);
  const home = path.join(root, id);
  const lastUse = async () => (await readRecord(recordFile))?.updatedAt
    ?? await fs.stat(home).then(stat => stat.mtimeMs, () => undefined);
  const before = await lastUse();
  if (before === undefined) {
    // Only a lock is left: remove it once its owner is gone.
    if (!heldHere.has(lockFile) && await lockIsStale(lockFile)) await fs.rm(lockFile, { force: true });
    return;
  }
  if (now - before <= ANTIGRAVITY_SESSION_TTL_MS) return;
  if (!await tryLock(lockFile)) return;
  try {
    const confirmed = await lastUse();
    if (confirmed === undefined || now - confirmed <= ANTIGRAVITY_SESSION_TTL_MS) return;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(recordFile, { force: true });
  } finally {
    heldHere.delete(lockFile);
    await fs.rm(lockFile, { force: true });
  }
}

/** Remove idle sessions and the one-off homes of runs whose process crashed. */
export async function sweepAntigravityRuntime(now = Date.now()): Promise<void> {
  const runtimeRoot = antigravityRuntimeRoot();
  const sessionsRoot = antigravitySessionsRoot();
  const invocations = await fs.readdir(runtimeRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of invocations) {
    if (!entry.isDirectory() || !entry.name.startsWith('invocation-')) continue;
    const directory = path.join(runtimeRoot, entry.name);
    const stat = await fs.stat(directory).catch(() => undefined);
    if (stat && now - stat.mtimeMs > STALE_INVOCATION_MS) await fs.rm(directory, { recursive: true, force: true });
  }
  const ids = new Set((await fs.readdir(sessionsRoot).catch(() => []))
    .map(name => name.replace(/\.(?:json|lock)$/, ''))
    .filter(name => /^[a-f0-9]{40}$/.test(name)));
  for (const id of ids) await removeIfIdle(sessionsRoot, id, now);
}

let lastSweep = 0;
let sweeping: Promise<void> | undefined;
export function scheduleAntigravityRuntimeSweep(now = Date.now()): void {
  if (sweeping || now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  sweeping = sweepAntigravityRuntime(now)
    .catch(() => { log.warn('Antigravity runtime cleanup will retry later'); lastSweep = 0; })
    .finally(() => { sweeping = undefined; });
}

/** Test-only: let the next call sweep at once and wait for a running sweep. */
export async function _resetAntigravitySweepForTests(): Promise<void> {
  await sweeping;
  lastSweep = 0;
}
