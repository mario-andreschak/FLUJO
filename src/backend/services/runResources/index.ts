import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
import { loadItem, writeFileAtomic, runInWriteChain } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import {
  RUN_RESOURCE_SCHEME,
  RunResourceEntry,
  RunResourceKind,
  RunResourceProducer,
  RunResourceAccess,
  RunResourceSettings,
  DEFAULT_RUN_RESOURCE_SETTINGS,
} from '@/shared/types/runResources';
import type { MCPReadResourceResult } from '@/shared/types/mcp';

/**
 * Run-scoped resource store (Tier 3 data flow).
 *
 * Persists data artifacts produced during flow runs under
 *   db/run-resources/<conversationId>/index.json   (RunResourceEntry[])
 *   db/run-resources/<conversationId>/<id>.dat     (payload)
 * and serves them back in MCP ReadResourceResult shape.
 *
 * Deliberately dependency-light: this module must never import mcpService or
 * flow modules — both the MCP layer (internal "flujo" server) and the engine
 * (auto-capture) import THIS module, and pulling their imports in here would
 * join the internalTools import cycle.
 *
 * Writes never throw at callers that must not fail a run: writeRunResource
 * returns a `{ skipped }` marker instead when a cap refuses the payload, and
 * capture call sites treat any thrown error as "keep the inline content".
 */

const log = createLogger('backend/services/runResources');

// Mutable so tests can point the store at a temp directory (same seam pattern
// as conversationLog's _setConversationLogDirForTests).
let runResourcesDir = path.join(getDataDir(), 'db', 'run-resources');

// Ids and conversation ids become file/directory names, so they must pass the
// same gate as storage collection ids — anything else could escape the store
// directory (path traversal). URIs are PARSED into these ids and re-validated;
// they are never joined into paths directly (Windows-safe: only uuid-shaped
// names ever reach the filesystem).
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeId(id: string, what: string): void {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Unsafe run-resource ${what}: ${JSON.stringify(id)}`);
  }
}

const conversationDir = (conversationId: string) => path.join(runResourcesDir, conversationId);
const indexPath = (conversationId: string) => path.join(conversationDir(conversationId), 'index.json');
const payloadPath = (conversationId: string, id: string) => path.join(conversationDir(conversationId), `${id}.dat`);
const chainKey = (conversationId: string) => `run-resources/${conversationId}`;

export function buildRunResourceUri(conversationId: string, id: string): string {
  return `${RUN_RESOURCE_SCHEME}${conversationId}/${id}`;
}

/**
 * Parse a flujo://run/<conversationId>/<id> URI. Returns null for anything
 * else (including URIs whose segments would be unsafe as file names).
 */
export function parseRunResourceUri(uri: string): { conversationId: string; id: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith(RUN_RESOURCE_SCHEME)) return null;
  const rest = uri.slice(RUN_RESOURCE_SCHEME.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const [conversationId, id] = parts;
  if (!SAFE_ID.test(conversationId) || !SAFE_ID.test(id)) return null;
  return { conversationId, id };
}

// --- Settings ---------------------------------------------------------------

let settingsCache: { value: RunResourceSettings; at: number } | null = null;
const SETTINGS_TTL_MS = 30_000;

export async function getRunResourceSettings(): Promise<RunResourceSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.value;
  }
  let value: RunResourceSettings;
  try {
    const stored = await loadItem<Partial<RunResourceSettings>>(
      StorageKey.RUN_RESOURCE_SETTINGS,
      DEFAULT_RUN_RESOURCE_SETTINGS
    );
    // Merge so a hand-edited partial settings file keeps sane defaults.
    value = { ...DEFAULT_RUN_RESOURCE_SETTINGS, ...stored };
  } catch (error) {
    log.warn('Failed to load run-resource settings; using defaults', error);
    value = DEFAULT_RUN_RESOURCE_SETTINGS;
  }
  settingsCache = { value, at: Date.now() };
  return value;
}

/** Test seam: drop the settings cache. */
export function _clearRunResourceSettingsCache(): void {
  settingsCache = null;
}

// --- Index cache -------------------------------------------------------------

// Global-backed like __mcp_clients: Next.js can instantiate this module more
// than once (route bundles, hot reload) and all instances must share the cache.
// Disk is the cold-start source of truth.
declare global {
  // eslint-disable-next-line no-var
  var __flujo_run_resources: Map<string, RunResourceEntry[]> | undefined;
}
const indexCache: Map<string, RunResourceEntry[]> =
  global.__flujo_run_resources ?? (global.__flujo_run_resources = new Map());

async function loadIndex(conversationId: string): Promise<RunResourceEntry[]> {
  const cached = indexCache.get(conversationId);
  if (cached) return cached;
  let entries: RunResourceEntry[] = [];
  try {
    const content = await fs.readFile(indexPath(conversationId), 'utf-8');
    if (content.trim().length > 0) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) entries = parsed as RunResourceEntry[];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error(`Failed to read run-resource index for ${conversationId}; treating as empty`, error);
    }
  }
  indexCache.set(conversationId, entries);
  return entries;
}

/**
 * Run the ENTIRE read-modify-write inside one
 * runInWriteChain(chainKey(conversationId)) critical section. `loadIndex`
 * happens INSIDE the chain, so concurrent writers to the SAME conversation are
 * strictly serialized and neither can clobber the other (the lost-update bug).
 * The mutator may be async so it can write the payload file within the same
 * critical section, keeping payload + index mutually consistent. When it
 * returns the SAME array reference (a no-op) no index write happens. Different
 * conversations use different chain keys and stay parallel.
 */
async function mutateIndex<T>(
  conversationId: string,
  mutator: (entries: RunResourceEntry[]) => Promise<{ next: RunResourceEntry[]; result: T }>
): Promise<T> {
  return runInWriteChain(chainKey(conversationId), async () => {
    const entries = await loadIndex(conversationId);
    const { next, result } = await mutator(entries);
    if (next !== entries) {
      indexCache.set(conversationId, next);
      await writeFileAtomic(indexPath(conversationId), JSON.stringify(next, null, 2));
    }
    return result;
  });
}

// --- Store API ---------------------------------------------------------------

export type WriteRunResourceInput = {
  conversationId: string;
  name?: string;
  mimeType?: string;
  kind: RunResourceKind;
  /** Payload; absent for kind 'link' (a tracked pointer, no stored bytes). */
  data?: { text: string } | { base64: string };
  producedBy: RunResourceProducer;
  origin?: { server: string; uri: string };
};

export type WriteRunResourceResult = RunResourceEntry | { skipped: 'size-cap' | 'conversation-cap' };

export async function writeRunResource(input: WriteRunResourceInput): Promise<WriteRunResourceResult> {
  assertSafeId(input.conversationId, 'conversationId');
  const settings = await getRunResourceSettings();

  // Decode/measure the payload first so caps are enforced on real bytes.
  let payload: Buffer | null = null;
  let encoding: 'utf8' | 'base64' = 'utf8';
  if (input.data) {
    if ('text' in input.data) {
      payload = Buffer.from(input.data.text, 'utf8');
      encoding = 'utf8';
    } else {
      payload = Buffer.from(input.data.base64, 'base64');
      encoding = 'base64';
    }
  }
  const size = payload?.byteLength ?? 0;

  if (size > settings.maxResourceBytes) {
    log.warn(`Run-resource write skipped (size ${size} > cap ${settings.maxResourceBytes})`, {
      conversationId: input.conversationId, name: input.name, kind: input.kind,
    });
    return { skipped: 'size-cap' };
  }

  const id = randomUUID();
  let replacedToUnlink: RunResourceEntry | undefined;

  // The read (loadIndex), the conversation-byte cap check, the payload file
  // write, and the index compute all run INSIDE one per-conversation critical
  // section, so a concurrent writer to the same conversation can never clobber
  // this write and the payload + index stay mutually consistent.
  const result = await mutateIndex<WriteRunResourceResult>(input.conversationId, async (entries) => {
    // Named overwrite: a repeated captureResource NAME replaces the previous
    // entry (and its payload) so `${res:NAME}` is stable — mirrors the
    // captureVariable last-write-wins semantics.
    const replaced = input.name ? entries.find(e => e.name === input.name) : undefined;

    const usedBytes = entries.reduce((sum, e) => sum + (e === replaced ? 0 : e.size), 0);
    if (usedBytes + size > settings.maxConversationBytes) {
      log.warn(`Run-resource write skipped (conversation budget ${usedBytes}+${size} > ${settings.maxConversationBytes})`, {
        conversationId: input.conversationId, name: input.name, kind: input.kind,
      });
      return { next: entries, result: { skipped: 'conversation-cap' } };
    }

    const entry: RunResourceEntry = {
      id,
      uri: buildRunResourceUri(input.conversationId, id),
      conversationId: input.conversationId,
      name: input.name,
      mimeType: input.mimeType,
      size,
      kind: input.kind,
      encoding,
      createdAt: Date.now(),
      producedBy: input.producedBy,
      origin: input.origin,
      readBy: [],
    };

    if (payload) {
      await fs.mkdir(conversationDir(input.conversationId), { recursive: true });
      await fs.writeFile(payloadPath(input.conversationId, id), payload);
    }

    const next = replaced ? entries.filter(e => e !== replaced) : entries.slice();
    next.push(entry);
    replacedToUnlink = replaced && replaced.size > 0 ? replaced : undefined;
    log.debug(`Stored run resource ${entry.uri}`, { kind: entry.kind, size, name: entry.name });
    return { next, result: entry };
  });

  if (replacedToUnlink) {
    // Best-effort: the replaced payload is already unreferenced by the index.
    fs.unlink(payloadPath(input.conversationId, replacedToUnlink.id)).catch(() => { /* may not exist */ });
  }

  return result;
}

export async function listRunResources(conversationId: string): Promise<RunResourceEntry[]> {
  assertSafeId(conversationId, 'conversationId');
  return (await loadIndex(conversationId)).slice();
}

/**
 * Newest-first across all conversations, capped. Used by the internal "flujo"
 * server's resources/list. Reads directories on disk (not just cache) so a
 * fresh process still lists resources from earlier runs.
 */
export async function listAllRunResources(limit = 200): Promise<RunResourceEntry[]> {
  let conversationIds: string[] = [];
  try {
    const dirents = await fs.readdir(runResourcesDir, { withFileTypes: true });
    conversationIds = dirents.filter(d => d.isDirectory() && SAFE_ID.test(d.name)).map(d => d.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const all: RunResourceEntry[] = [];
  for (const conversationId of conversationIds) {
    all.push(...await loadIndex(conversationId));
  }
  all.sort((a, b) => b.createdAt - a.createdAt);
  return all.slice(0, limit);
}

export async function findRunResourceByName(
  conversationId: string,
  name: string
): Promise<RunResourceEntry | null> {
  assertSafeId(conversationId, 'conversationId');
  const entries = await loadIndex(conversationId);
  return entries.find(e => e.name === name) ?? null;
}

/**
 * Read a run resource by URI in MCP ReadResourceResult shape. Appends the
 * access to the entry's lineage (awaited, best-effort persist routed through
 * the per-conversation write chain so it can never clobber a concurrent write;
 * a failed lineage write still never fails the read). Returns null for unknown
 * URIs. Event emission is the CALLER's job — this module stays dependency-light.
 */
export async function readRunResource(
  uri: string,
  access?: RunResourceAccess
): Promise<{ entry: RunResourceEntry; contents: MCPReadResourceResult } | null> {
  const parsed = parseRunResourceUri(uri);
  if (!parsed) return null;
  const entries = await loadIndex(parsed.conversationId);
  const entry = entries.find(e => e.id === parsed.id);
  if (!entry) return null;

  let contents: MCPReadResourceResult;
  if (entry.kind === 'link') {
    // No stored payload; point the reader at the native origin.
    contents = {
      contents: [{
        uri: entry.uri,
        mimeType: entry.mimeType ?? 'text/plain',
        text: `Run resource link → ${entry.origin ? `${entry.origin.server}: ${entry.origin.uri}` : 'unknown origin'}`,
      }],
    };
  } else {
    let payload: Buffer;
    try {
      payload = await fs.readFile(payloadPath(parsed.conversationId, parsed.id));
    } catch (error) {
      log.error(`Run-resource payload missing for ${uri}`, error);
      return null;
    }
    contents = entry.encoding === 'utf8'
      ? { contents: [{ uri: entry.uri, mimeType: entry.mimeType ?? 'text/plain', text: payload.toString('utf8') }] }
      : { contents: [{ uri: entry.uri, mimeType: entry.mimeType ?? 'application/octet-stream', blob: payload.toString('base64') }] };
  }

  if (access) {
    // Route the lineage append through the write chain and AWAIT it (no more
    // fire-and-forget). Re-find the entry by id inside the critical section and
    // build a fresh entry/array so the append is race-safe against concurrent
    // writers. Wrapped in try/catch so a failed persist can never fail the read.
    try {
      await mutateIndex<void>(parsed.conversationId, async (entries) => {
        const target = entries.find(e => e.id === parsed.id);
        if (!target) return { next: entries, result: undefined };
        const updated: RunResourceEntry = { ...target, readBy: [...target.readBy, access] };
        return { next: entries.map(e => (e === target ? updated : e)), result: undefined };
      });
      entry.readBy.push(access);
    } catch (error) {
      log.warn(`Failed to persist readBy for ${uri}`, error);
    }
  }
  return { entry, contents };
}

/** Remove a conversation's resources (called from conversation DELETE). */
export async function deleteRunResources(conversationId: string): Promise<void> {
  assertSafeId(conversationId, 'conversationId');
  indexCache.delete(conversationId);
  await runInWriteChain(chainKey(conversationId), async () => {
    try {
      await fs.rm(conversationDir(conversationId), { recursive: true, force: true });
      log.debug(`Deleted run resources for conversation ${conversationId}`);
    } catch (error) {
      log.warn(`Failed to delete run resources for ${conversationId}`, error);
    }
  });
}

/** Test seam: point the store at a temp directory. Returns the previous dir. */
export function _setRunResourcesDirForTests(dir: string): string {
  const previous = runResourcesDir;
  runResourcesDir = dir;
  indexCache.clear();
  return previous;
}
