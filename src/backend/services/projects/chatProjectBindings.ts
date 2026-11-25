/**
 * Each chat's project folder, kept in a small file of its own beside the chat
 * (`db/chat-projects/<chat id>.json`) and deleted together with the chat. There
 * is no shared list and no limit on how many chats keep their folder.
 *
 * Older versions kept every chat's choice in the workspace's `.workspace.json`
 * (`chatProjects`), capped at 2000 entries. Those entries move into per-chat
 * files once, safely:
 *
 *  1. the old map is copied to a backup file before anything changes;
 *  2. every entry of a chat that still exists gets its own file — a file that
 *     is already there holds a newer choice and is kept;
 *  3. only then are the moved entries taken out of `.workspace.json`.
 *
 * Until an entry has moved, reads still find it in the old map, so a crash at
 * any point loses nothing: the next start simply finishes the move. Entries of
 * chats that were deleted are dropped (they remain in the backup).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { FILE_RECORD_ID_RULE } from '@/shared/recordId';
import { fileErrorCode, retryTransientFileOperation } from '@/utils/transientFileRetry';
import { deleteCollectionItem, runInWriteChain, writeFileAtomic } from '@/utils/storage/backend';
import {
  getCurrentWorkspace,
  getWorkspaceDbDir,
  getWorkspaceDir,
  readWorkspaceMetadata,
  runWithWorkspace,
  updateWorkspaceMetadata,
  type WorkspaceMetadata,
} from '@/utils/workspace';
import { getConversationStates } from '@/backend/execution/flow/conversationStateRegistry';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';

const log = createLogger('backend/services/projects/chatProjectBindings');

const COLLECTION = 'chat-projects';
/** The same rule chat files follow, so every stored chat can keep a folder. */
const CHAT_ID_PATTERN = FILE_RECORD_ID_RULE.pattern;
const LEGACY_FIELD = 'chatProjects';
const LEGACY_BACKUP_FILE = '.workspace.chat-projects.backup.json';
const MIGRATION_WORKERS = 8;
const MIGRATION_BATCH = 200;
/** A move that failed (for example a locked file) is tried again after this pause. */
const MIGRATION_RETRY_MS = 30_000;

export interface ChatProjectBinding {
  /** The project (one of the workspace roots) the chat belongs to. */
  project: string;
  /** The folder the chat's agents work in: the project or one of its worktrees. */
  path: string;
}

/** A stored choice, or a file that exists but cannot be read. */
export type StoredChatProject = ChatProjectBinding | 'unreadable';

export function isStorableChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_PATTERN.test(value);
}

function bindingFile(chatId: string): string {
  return path.join(getWorkspaceDbDir(), COLLECTION, `${chatId}.json`);
}

function chainKey(chatId: string): string {
  return `${COLLECTION}/${chatId}`;
}

function parseBinding(value: unknown): ChatProjectBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { project, path: folder } = value as Record<string, unknown>;
  if (typeof project !== 'string' || typeof folder !== 'string') return undefined;
  if (!path.isAbsolute(project) || !path.isAbsolute(folder)) return undefined;
  return { project, path: folder };
}

function serialize(binding: ChatProjectBinding): string {
  return `${JSON.stringify({ version: 1, project: binding.project, path: binding.path }, null, 2)}\n`;
}

async function readBindingFile(chatId: string): Promise<StoredChatProject | undefined> {
  let text: string;
  try {
    text = await retryTransientFileOperation(() => fs.readFile(bindingFile(chatId), 'utf8'));
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const binding = parseBinding(parsed);
  if (binding) return binding;
  log.warn(`The project folder of chat ${chatId} cannot be read; the chat has no folder until one is picked.`);
  return 'unreadable';
}

/**
 * The bindings still waiting in `.workspace.json`, as a Map so a chat id is
 * never looked up as a plain-object property (`constructor` and friends).
 */
export function legacyChatProjects(metadata: WorkspaceMetadata): Map<string, ChatProjectBinding> {
  const bindings = new Map<string, ChatProjectBinding>();
  const raw = metadata[LEGACY_FIELD];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bindings;
  for (const [chatId, value] of Object.entries(raw as Record<string, unknown>)) {
    const binding = parseBinding(value);
    if (isStorableChatId(chatId) && binding) bindings.set(chatId, binding);
  }
  return bindings;
}

/**
 * The chat's stored choice: its own file, else (until the one-time move has
 * finished) its entry in the old shared map. `metadata` is the workspace's
 * current `.workspace.json` record.
 */
export async function readChatProjectRecord(
  chatId: string,
  metadata: WorkspaceMetadata,
): Promise<StoredChatProject | undefined> {
  if (!isStorableChatId(chatId)) return undefined;
  scheduleLegacyChatProjectMigration(metadata);
  return await readBindingFile(chatId) ?? legacyChatProjects(metadata).get(chatId);
}

/** Store the chat's choice, replacing any earlier one. */
export async function writeChatProjectRecord(chatId: string, binding: ChatProjectBinding): Promise<void> {
  if (!isStorableChatId(chatId)) throw new Error('Invalid conversation id.');
  await runInWriteChain(chainKey(chatId), () => writeFileAtomic(bindingFile(chatId), serialize(binding)));
}

/**
 * Store a first choice only when the chat has none yet, checked inside the
 * chat's write queue so a choice made meanwhile is never overwritten.
 * `choose` sees the current `.workspace.json` record and may decline.
 */
export async function writeChatProjectRecordIfUnset(
  chatId: string,
  choose: (metadata: WorkspaceMetadata) => ChatProjectBinding | undefined,
): Promise<void> {
  if (!isStorableChatId(chatId)) return;
  await runInWriteChain(chainKey(chatId), async () => {
    if (await readBindingFile(chatId) !== undefined) return;
    const metadata = await readWorkspaceMetadata();
    if (legacyChatProjects(metadata).has(chatId)) return;
    const binding = choose(metadata);
    if (binding) await writeFileAtomic(bindingFile(chatId), serialize(binding));
  });
}

/**
 * Forget a deleted chat's folder. Like the chat's summary this is derived
 * data: a failure is logged and never fails the chat's deletion.
 */
export async function deleteChatProject(chatId: string): Promise<void> {
  if (!isStorableChatId(chatId)) return;
  try {
    await deleteCollectionItem(COLLECTION, chatId);
  } catch (error) {
    log.warn(`Could not delete the project folder record of chat ${chatId}.`, error);
  }
}

async function chatExists(chatId: string): Promise<boolean> {
  if (getConversationStates().has(chatId)) return true;
  try {
    await retryTransientFileOperation(() => fs.stat(path.join(getWorkspaceDbDir(), 'conversations', `${chatId}.json`)));
    return true;
  } catch (error) {
    // Only a chat that is certainly gone is dropped; anything unclear keeps it.
    return fileErrorCode(error) !== 'ENOENT';
  }
}

function sameBinding(a: ChatProjectBinding | undefined, b: ChatProjectBinding | undefined): boolean {
  return Boolean(a && b && a.project === b.project && a.path === b.path);
}

/** Add the old map to the backup file; entries already there are kept. */
async function backupLegacyChatProjects(workspace: string, raw: unknown): Promise<void> {
  const file = path.join(getWorkspaceDir(workspace), LEGACY_BACKUP_FILE);
  let saved: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await retryTransientFileOperation(() => fs.readFile(file, 'utf8'))) as { chatProjects?: unknown };
    if (parsed.chatProjects && typeof parsed.chatProjects === 'object' && !Array.isArray(parsed.chatProjects)) {
      saved = parsed.chatProjects as Record<string, unknown>;
    }
  } catch (error) {
    if (fileErrorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const current = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const merged = { ...saved, ...current };
  if (JSON.stringify(merged) === JSON.stringify(saved)) return;
  await writeFileAtomic(file, `${JSON.stringify({
    note: 'Chat project folders as .workspace.json stored them before each chat kept its own (db/chat-projects). FLUJO does not read this file.',
    savedAt: new Date().toISOString(),
    chatProjects: merged,
  }, null, 2)}\n`);
}

export interface LegacyMigrationResult {
  /** Entries that got their own file. */
  moved: number;
  /** Entries whose chat already had a newer choice of its own. */
  alreadyMoved: number;
  /** Entries of deleted chats, and entries no chat could have. */
  dropped: number;
  /** Entries left in the old map because they could not be moved yet. */
  remaining: number;
}

/**
 * Move the current workspace's old `chatProjects` map into per-chat files.
 * Safe to run again at any time and after a crash at any point.
 */
export async function migrateLegacyChatProjects(): Promise<LegacyMigrationResult> {
  const workspace = getCurrentWorkspace();
  const result: LegacyMigrationResult = { moved: 0, alreadyMoved: 0, dropped: 0, remaining: 0 };
  const metadata = await readWorkspaceMetadata(workspace);
  const raw = metadata[LEGACY_FIELD];
  if (raw === undefined) return result;

  await backupLegacyChatProjects(workspace, raw);

  const entries = [...legacyChatProjects(metadata)];
  const settled = new Map<string, ChatProjectBinding>();
  const failures: unknown[] = [];
  const moveOne = async ([chatId, binding]: [string, ChatProjectBinding]) => {
    try {
      await runInWriteChain(chainKey(chatId), async () => {
        const own = await readBindingFile(chatId);
        if (own !== undefined && own !== 'unreadable') {
          result.alreadyMoved += 1;
        } else if (!(await chatExists(chatId))) {
          result.dropped += 1;
        } else {
          await writeFileAtomic(bindingFile(chatId), serialize(binding));
          result.moved += 1;
        }
        settled.set(chatId, binding);
      });
    } catch (error) {
      failures.push(error);
    }
  };
  // One workspace admission per batch instead of one per file keeps a large
  // move fast, while a workspace snapshot waits for one batch at most.
  for (let start = 0; start < entries.length; start += MIGRATION_BATCH) {
    const batch = entries.slice(start, start + MIGRATION_BATCH);
    let cursor = 0;
    await withWorkspaceMutation(() => Promise.all(Array.from(
      { length: Math.min(MIGRATION_WORKERS, batch.length) },
      async () => { for (let index = cursor++; index < batch.length; index = cursor++) await moveOne(batch[index]); },
    )), workspace);
  }

  // Take out only what was handled, and only while it still holds the value
  // that was handled, so nothing written to the old map meanwhile is lost.
  await updateWorkspaceMetadata(workspace, current => {
    const currentRaw = current[LEGACY_FIELD];
    if (currentRaw === undefined) return current;
    const valid = legacyChatProjects(current);
    const isMap = currentRaw !== null && typeof currentRaw === 'object' && !Array.isArray(currentRaw);
    const rawEntries = isMap ? Object.entries(currentRaw as Record<string, unknown>) : [];
    const remaining = Object.fromEntries(rawEntries.filter(([chatId]) =>
      valid.has(chatId) && !sameBinding(settled.get(chatId), valid.get(chatId))));
    const unusable = isMap ? rawEntries.length - valid.size : 1;
    result.remaining = Object.keys(remaining).length;
    if (unusable === 0 && result.remaining > 0 && result.remaining === valid.size) return current;
    result.dropped += unusable;
    const next: WorkspaceMetadata = { ...current };
    if (result.remaining === 0) delete next[LEGACY_FIELD];
    else next[LEGACY_FIELD] = remaining;
    return next;
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} chat project folder(s) could not be moved yet; they stay in .workspace.json and are tried again.`);
  }
  return result;
}

const migrationHost = globalThis as typeof globalThis & {
  __flujoChatProjectMigrationsV1?: Map<string, { running?: Promise<void>; retryAt?: number }>;
};
const migrations = migrationHost.__flujoChatProjectMigrationsV1 ??= new Map();

/**
 * Start the one-time move in the background when `.workspace.json` still has
 * the old map. Reads never wait for it: the old map answers until an entry
 * has moved. A failed move is tried again on a later read.
 */
export function scheduleLegacyChatProjectMigration(metadata: WorkspaceMetadata): void {
  if (metadata[LEGACY_FIELD] === undefined) return;
  const workspace = getCurrentWorkspace();
  const state = migrations.get(workspace) ?? {};
  if (state.running || (state.retryAt !== undefined && Date.now() < state.retryAt)) return;
  const running = runWithWorkspace(workspace, () => migrateLegacyChatProjects())
    .then(result => {
      migrations.delete(workspace);
      if (result.moved || result.dropped) {
        log.info(`Moved chat project folders into their chats in workspace ${workspace}`, result);
      }
    })
    .catch(error => {
      migrations.set(workspace, { retryAt: Date.now() + MIGRATION_RETRY_MS });
      log.warn(`Chat project folders of workspace ${workspace} could not all be moved yet; trying again later.`, error);
    });
  migrations.set(workspace, { running });
}

/** Test hook: wait for a background move of the current workspace to settle. */
export async function _settleChatProjectMigrationForTests(): Promise<void> {
  await migrations.get(getCurrentWorkspace())?.running;
  migrations.delete(getCurrentWorkspace());
}
