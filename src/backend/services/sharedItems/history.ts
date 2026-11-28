import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { runInWriteChain, writeFileAtomic } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';
import { SHARED_ITEM_KINDS, type SharedItemKind } from './kinds';

const log = createLogger('backend/services/sharedItems/history');

/**
 * Change history of shared items (#575, step 575-3): who changed which flow,
 * model or MCP server, when, and what it looked like afterwards (without
 * secrets, see `secrets.ts`).
 *
 * One append-only file per item: `<workspace>/db/history/<kind>/<id hash>.jsonl`,
 * inside the workspace, so workspace backups carry it and other workspaces
 * never see it. Only written while multi-user mode is on.
 *
 * Old entries are pruned by themselves: an item keeps its newest
 * {@link HISTORY_KEEP_ENTRIES} entries and at most {@link HISTORY_KEEP_BYTES}.
 * Writing history never refuses or fails a save; a problem is logged and the
 * save goes on.
 */

export const HISTORY_KEEP_ENTRIES = 200;
/** Above this many entries the file is rewritten down to {@link HISTORY_KEEP_ENTRIES}. Pruning in batches keeps rewrites rare. */
export const HISTORY_PRUNE_AT_ENTRIES = 240;
/** Large flows make large snapshots; past this size the oldest entries go first. */
export const HISTORY_KEEP_BYTES = 16 * 1024 * 1024;

export const HISTORY_ACTIONS = ['created', 'saved', 'restored', 'deleted', 'copied-in'] as const;
export type HistoryAction = typeof HISTORY_ACTIONS[number];

export const historyEntrySchema = z.object({
  v: z.literal(1),
  /** Sortable: time, then random. */
  entryId: z.string().regex(/^[0-9]{13}-[A-Za-z0-9_-]{6,16}$/),
  at: z.number().int().nonnegative(),
  kind: z.enum(SHARED_ITEM_KINDS),
  itemId: z.string().min(1).max(256),
  action: z.enum(HISTORY_ACTIONS),
  /** Who did it. `userId` is `null` for FLUJO itself. */
  actor: z.object({ userId: z.string().max(80).nullable(), name: z.string().max(100) }).strict(),
  /** The item's version after the change (`null` once deleted). */
  revision: z.string().max(80).nullable(),
  /** The version it replaced (`null` for a new item). */
  previousRevision: z.string().max(80).nullable(),
  /** For `restored`: the entry that was brought back. */
  restoredFrom: z.string().max(40).optional(),
  /** For `copied-in`: where it came from. */
  copiedFrom: z.object({ workspace: z.string().max(64), itemId: z.string().max(256) }).strict().optional(),
  /** What the item looked like after the change, secrets masked. `null` when deleted. */
  snapshot: z.unknown(),
}).strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** An entry without its snapshot, for lists. */
export type HistorySummary = Omit<HistoryEntry, 'snapshot' | 'v'>;

function fileName(itemId: string): string {
  return `${createHash('sha256').update(itemId).digest('hex').slice(0, 40)}.jsonl`;
}

export function historyFilePath(kind: SharedItemKind, itemId: string, workspace?: string): string {
  return path.join(getWorkspaceDataDir(workspace), 'db', 'history', kind, fileName(itemId));
}

function newEntryId(at: number): string {
  return `${String(at).padStart(13, '0').slice(-13)}-${randomBytes(6).toString('base64url')}`;
}

/** Antivirus or the indexer can hold a history file for a moment; such a failure is waited out. */
function withRetry<T>(task: () => Promise<T>): Promise<T> {
  return retryTransientFileOperation(task, { label: 'shared-item-history' });
}

/** Parse a history file. A torn or damaged line is skipped, never fatal. */
function parseEntries(text: string, kind: SharedItemKind, itemId: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = historyEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.kind === kind && parsed.data.itemId === itemId) entries.push(parsed.data);
    } catch { /* a line cut short by a crash; the rest stays readable */ }
  }
  return entries;
}

async function readEntries(file: string, kind: SharedItemKind, itemId: string): Promise<HistoryEntry[]> {
  try {
    return parseEntries(await withRetry(() => fs.readFile(file, 'utf8')), kind, itemId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** True for a missing or empty file, or one whose last byte is a newline. */
async function endsWithNewline(file: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await withRetry(() => fs.open(file, 'r'));
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 10;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  } finally {
    await handle?.close();
  }
}

function countLines(buffer: Buffer): number {
  let lines = 0;
  for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) lines++;
  return lines;
}

/** Keep the newest entries that fit both limits. */
export function pruneEntries(entries: readonly HistoryEntry[], keep = HISTORY_KEEP_ENTRIES, keepBytes = HISTORY_KEEP_BYTES): HistoryEntry[] {
  const kept: HistoryEntry[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0 && kept.length < keep; index--) {
    const size = JSON.stringify(entries[index]).length + 1;
    if (kept.length > 0 && bytes + size > keepBytes) break;
    bytes += size;
    kept.push(entries[index]);
  }
  return kept.reverse();
}

export interface RecordInput {
  readonly kind: SharedItemKind;
  readonly itemId: string;
  readonly action: HistoryAction;
  readonly actor: HistoryEntry['actor'];
  readonly revision: string | null;
  readonly previousRevision: string | null;
  readonly snapshot: unknown;
  readonly restoredFrom?: string;
  readonly copiedFrom?: HistoryEntry['copiedFrom'];
  readonly at?: number;
}

/**
 * Add one entry. Never throws: history must never cost anyone a save. Runs in
 * the selected workspace (the caller is inside a workspace request).
 */
export async function recordHistory(input: RecordInput): Promise<HistoryEntry | null> {
  const at = input.at ?? Date.now();
  let entry: HistoryEntry;
  try {
    entry = historyEntrySchema.parse({
      v: 1, entryId: newEntryId(at), at, kind: input.kind, itemId: input.itemId, action: input.action,
      actor: { userId: input.actor.userId, name: input.actor.name.slice(0, 100) },
      revision: input.revision, previousRevision: input.previousRevision,
      ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}),
      ...(input.copiedFrom ? { copiedFrom: input.copiedFrom } : {}),
      snapshot: input.snapshot ?? null,
    });
  } catch (error) {
    log.warn(`Could not describe a change of ${input.kind} ${input.itemId} for its history`, error);
    return null;
  }
  const file = historyFilePath(input.kind, input.itemId);
  try {
    await runInWriteChain(`history/${input.kind}/${path.basename(file)}`, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // A line cut short by a crash must not swallow this entry: start on a new line.
      const separator = (await endsWithNewline(file)) ? '' : '\n';
      await withRetry(() => fs.appendFile(file, `${separator}${JSON.stringify(entry)}\n`, 'utf8'));
      const stat = await fs.stat(file);
      // Cheap checks first: every line is far longer than 64 bytes, and
      // counting newline bytes needs no parsing. Only a file over a limit is
      // parsed and rewritten.
      if (stat.size <= HISTORY_KEEP_BYTES && stat.size < HISTORY_PRUNE_AT_ENTRIES * 64) return;
      const raw = await withRetry(() => fs.readFile(file));
      if (stat.size <= HISTORY_KEEP_BYTES && countLines(raw) <= HISTORY_PRUNE_AT_ENTRIES) return;
      const kept = pruneEntries(parseEntries(raw.toString('utf8'), input.kind, input.itemId));
      await writeFileAtomic(file, kept.map(item => JSON.stringify(item)).join('\n') + '\n');
    });
    return entry;
  } catch (error) {
    log.warn(`Could not write the history of ${input.kind} ${input.itemId}; the change itself was saved`, error);
    return null;
  }
}

/** Every entry of an item, oldest first. Empty when it has no history. */
export async function listHistory(kind: SharedItemKind, itemId: string): Promise<HistoryEntry[]> {
  return readEntries(historyFilePath(kind, itemId), kind, itemId);
}

export function summarize(entry: HistoryEntry): HistorySummary {
  const { snapshot: _snapshot, v: _v, ...summary } = entry;
  return summary;
}

export async function getHistoryEntry(kind: SharedItemKind, itemId: string, entryId: string): Promise<HistoryEntry | null> {
  return (await listHistory(kind, itemId)).find(entry => entry.entryId === entryId) ?? null;
}

/**
 * Did only this person change the item since `baseRevision`? Walks back from
 * `currentRevision` through the recorded changes. Any step by someone else,
 * or a step that was not recorded (another program changed the item), means
 * "no": the save must not silently replace that change.
 */
export function changedOnlyBy(entries: readonly HistoryEntry[], baseRevision: string, currentRevision: string,
  userId: string): boolean {
  let revision = currentRevision;
  const seen = new Set<string>();
  while (revision !== baseRevision) {
    if (seen.has(revision)) return false;
    seen.add(revision);
    let step: HistoryEntry | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].revision === revision) { step = entries[index]; break; }
    }
    if (!step || step.actor.userId !== userId || step.previousRevision === null) return false;
    revision = step.previousRevision;
  }
  return true;
}

/** The newest recorded change that produced this revision, to say "Anna saved this at 10:42". */
export function lastChangeTo(entries: readonly HistoryEntry[], revision: string): HistoryEntry | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].revision === revision) return entries[index];
  }
  return null;
}
