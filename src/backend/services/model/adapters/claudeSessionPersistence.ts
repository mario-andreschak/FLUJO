import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import * as nodeModule from 'node:module';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import type { StoredSession } from './claudeSessionStore';

const VERSION = 2;
export const CLAUDE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;

export interface ClaudeTranscriptCheckpoint { bytes: number; records: number; sha256: string }

/** Canonicalize object keys, retaining array order and every provider-visible value. */
export function canonicalSessionValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSessionValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSessionValue(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sessionValueHash(value: unknown): string {
  return createHash('sha256').update(canonicalSessionValue(value)).digest('hex');
}

export function claudeSdkRuntimeIdentity(installationRoot = process.cwd()): { sdkVersion: string; bundledRuntimeVersion?: string } {
  // Keep resolution native, as the existing runtime discovery helpers do.
  // Webpack rejects static CommonJS resolution of this ESM-only SDK and can
  // rewrite a direct createRequire call to a build-host-dependent shim.
  const nativeCreateRequire: typeof nodeModule.createRequire = Reflect.get(nodeModule, 'createRequire');
  const resolver = nativeCreateRequire(path.join(installationRoot, 'package.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(resolver.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'));
  if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || typeof manifest.version !== 'string') throw new Error('Claude SDK identity is unavailable.');
  return { sdkVersion: manifest.version, ...(typeof manifest.claudeCodeVersion === 'string' ? { bundledRuntimeVersion: manifest.claudeCodeVersion } : {}) };
}

function metadataPath(): string | undefined {
  // Ordinary unit tests must never write into the user's selected workspace.
  // Persistence tests supply an isolated data root explicitly.
  if (process.env.NODE_ENV === 'test' && !process.env.FLUJO_TEST_CLAUDE_SESSION_DIR) return undefined;
  const root = process.env.NODE_ENV === 'test' && process.env.FLUJO_TEST_CLAUDE_SESSION_DIR
    ? process.env.FLUJO_TEST_CLAUDE_SESSION_DIR : getWorkspaceDataDir();
  return path.join(root, 'db', 'claude-sessions-v2');
}

export function loadClaudeSessions(): Map<string, StoredSession> {
  const result = new Map<string, StoredSession>();
  const file = metadataPath();
  if (!file) return result;
  try {
    for (const name of fs.readdirSync(file)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      let data: { version: number; workspace: string; key: string; entry: StoredSession };
      try {
        const target = path.join(file, name);
        if (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).size > 1024 * 1024) continue;
        data = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch { continue; }
      if (data.version !== VERSION || data.workspace !== getCurrentWorkspace()) continue;
      const { key, entry } = data;
      if (typeof key !== 'string' || name !== `${sessionValueHash(key)}.json`) continue;
      if (!entry || typeof entry.sessionId !== 'string'
        || !/^[a-zA-Z0-9_-]{1,256}$/.test(entry.sessionId)
        || !/^[a-f0-9]{64}$/.test(entry.prefixHash) || typeof entry.historyHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.historyHash)
        || !Number.isSafeInteger(entry.seenMessageCount) || entry.seenMessageCount < 0
        || !Number.isSafeInteger(entry.leadingSystemMessageCount) || entry.leadingSystemMessageCount < 0
        || !Number.isFinite(entry.updatedAt) || entry.updatedAt > Date.now()
        || Date.now() - entry.updatedAt > CLAUDE_SESSION_TTL_MS) continue;
      // A malformed accounting baseline cannot certify safe resumed metering.
      if (entry.usageCheckpoint && !validCheckpoint(entry.usageCheckpoint)) continue;
      if (entry.transcriptCheckpoint && !validTranscriptCheckpoint(entry.transcriptCheckpoint)) continue;
      result.set(key, entry);
    }
  } catch { /* Missing, incompatible or corrupt metadata always starts fresh. */ }
  return result;
}

function validCheckpoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as { modelUsage?: unknown; totalCostUsd?: unknown };
  if (!checkpoint.modelUsage || typeof checkpoint.modelUsage !== 'object' || Array.isArray(checkpoint.modelUsage)) return false;
  return Object.values(checkpoint.modelUsage).every(row => row && typeof row === 'object'
    && Object.values(row).every(count => typeof count === 'number' && Number.isFinite(count) && count >= 0))
    && (checkpoint.totalCostUsd === undefined || (typeof checkpoint.totalCostUsd === 'number'
      && Number.isFinite(checkpoint.totalCostUsd) && checkpoint.totalCostUsd >= 0));
}

function validTranscriptCheckpoint(value: unknown): value is ClaudeTranscriptCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as ClaudeTranscriptCheckpoint;
  return Number.isSafeInteger(checkpoint.bytes) && checkpoint.bytes > 0
    && Number.isSafeInteger(checkpoint.records) && checkpoint.records > 0
    && typeof checkpoint.sha256 === 'string' && /^[a-f0-9]{64}$/.test(checkpoint.sha256);
}

/** No prompt, conversation text, token, or tool arguments are persisted here. */
export function saveClaudeSession(key: string, entry: StoredSession): void {
  const directory = metadataPath();
  if (!directory || !entry.historyHash) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${sessionValueHash(key)}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: VERSION, workspace: getCurrentWorkspace(), key, entry }), { mode: 0o600 });
  fs.renameSync(temporary, file);
  // Other session owners may remove entries between enumeration and stat. GC
  // is best effort and must never discard a successfully written checkpoint.
  try {
    const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .flatMap(name => {
        try { return [{ path: path.join(directory, name), modified: fs.statSync(path.join(directory, name)).mtimeMs }]; }
        catch { return []; }
      }).sort((a, b) => b.modified - a.modified);
    for (const [index, item] of files.entries()) {
      if (index >= MAX_SESSIONS || Date.now() - item.modified > CLAUDE_SESSION_TTL_MS) {
        try { fs.rmSync(item.path, { force: true }); } catch { /* Retry GC on the next successful turn. */ }
      }
    }
  } catch { /* A checkpoint is usable even if directory GC is unavailable. */ }
}

export function removeClaudeSession(key: string): void {
  const directory = metadataPath();
  if (directory) fs.rmSync(path.join(directory, `${sessionValueHash(key)}.json`), { force: true });
}

/** Cross-process lock for the same SDK session; distinct keys stay independent. */
export async function acquireDurableClaudeSession(key: string, signal?: AbortSignal): Promise<() => void> {
  const directory = metadataPath();
  if (!directory) return () => {};
  fs.mkdirSync(path.join(directory, 'leases'), { recursive: true, mode: 0o700 });
  const lease = path.join(directory, 'leases', `${sessionValueHash(key)}.lock`);
  const nonce = randomUUID();
  const ownerName = `${process.pid}.${nonce}.json`;
  const candidate = `${lease}.${process.pid}.${nonce}.pending`;
  const ownerFile = path.join(lease, ownerName);
  const started = Date.now();
  // Publish a nonempty directory atomically. A crash during preparation leaves
  // only an unowned candidate, never an empty/partial active lease. Rename
  // cannot replace a nonempty directory on Windows or POSIX.
  fs.mkdirSync(candidate, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(candidate, ownerName), JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
    while (true) {
      signal?.throwIfAborted();
      try {
        fs.renameSync(candidate, lease);
        return () => {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          if (owner.nonce !== nonce) throw new Error('Claude session lease ownership changed.');
          fs.unlinkSync(ownerFile);
          try { fs.rmdirSync(lease); }
          catch (error) {
            // A waiter can publish its nonempty generation after our unlink.
            // Our ownership is already released; never remove that replacement.
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        try {
          const owners = fs.readdirSync(lease);
          if (owners.length === 0) {
            // A previous release/recovery may have crashed after unlink. Every
            // new owner is already nonempty when it becomes visible, so rmdir
            // cannot remove a newly published ownership generation.
            fs.rmdirSync(lease); continue;
          }
          const identity = owners.length === 1 && /^([1-9][0-9]*)\.([a-f0-9-]{36})\.json$/.exec(owners[0]);
          if (!identity) throw new Error('Unknown Claude session lease ownership.');
          const observedFile = path.join(lease, owners[0]);
          const pid = Number(identity[1]);
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (processError) {
              if ((processError as NodeJS.ErrnoException).code === 'ESRCH') {
                // Remove only the generation we observed. A competing recoverer
                // that already removed it gets ENOENT and cannot delete a new
                // owner's directory or nonce file.
                fs.unlinkSync(observedFile);
                fs.rmdirSync(lease);
                continue;
              }
            }
          }
        } catch { /* Unknown ownership never authorizes taking a live lease. */ }
        if (Date.now() - started > 30000) throw new Error('Claude session is still owned by another backend; retry after its turn ends.');
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new Error('Claude session wait cancelled.')); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 100);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
    }
  } finally {
    // Acquisition renamed this candidate away; cancellation/error removes only
    // our private unpublished generation, with no recursive deletion.
    try { fs.unlinkSync(path.join(candidate, ownerName)); } catch { /* Already published or not written. */ }
    try { fs.rmdirSync(candidate); } catch { /* Already published or preserve unknown contents. */ }
  }
}

/** Check only the isolated runtime's local transcript; never inspect host credentials. */
export async function captureClaudeSessionTranscript(home: string, sessionId: string): Promise<ClaudeTranscriptCheckpoint | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId)) return undefined;
  try {
    const projects = path.join(home, 'projects');
    const projectsStat = fs.lstatSync(projects);
    if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) return undefined;
    let checkpoint: ClaudeTranscriptCheckpoint | undefined;
    for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const file = path.join(projects, project.name, `${sessionId}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || checkpoint) return undefined;
      // Validate JSONL in bounded chunks without loading a large transcript into
      // memory. The SDK remains responsible for native transcript semantics.
      const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
      const decoder = new StringDecoder('utf8');
      const hash = createHash('sha256');
      let pending = '';
      let records = 0;
      try {
        for await (const chunk of stream) {
          hash.update(chunk);
          pending += decoder.write(chunk);
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            if (newline > 1024 * 1024) return undefined;
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (!line) continue;
            const record = JSON.parse(line);
            if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
            records++;
          }
          if (pending.length > 1024 * 1024) return undefined;
        }
        pending += decoder.end();
        if (pending.trim()) {
          const record = JSON.parse(pending);
          if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
          records++;
        }
        const after = fs.lstatSync(file);
        if (!records || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.ino !== stat.ino || after.dev !== stat.dev) return undefined;
        checkpoint = { bytes: stat.size, records, sha256: hash.digest('hex') };
      } finally { stream.destroy(); }
    }
    return checkpoint;
  } catch { /* Fresh canonical history is safer than an unreadable transcript. */ }
  return undefined;
}

/** Exact transcript lineage, including complete-record truncation and edits. */
export async function hasClaudeSessionTranscript(home: string, sessionId: string, expected: ClaudeTranscriptCheckpoint): Promise<boolean> {
  if (!validTranscriptCheckpoint(expected)) return false;
  const current = await captureClaudeSessionTranscript(home, sessionId);
  return Boolean(current && current.bytes === expected.bytes && current.records === expected.records && current.sha256 === expected.sha256);
}
