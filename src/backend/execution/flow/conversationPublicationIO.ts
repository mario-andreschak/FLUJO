import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { assertWorkspaceMutationOwned } from '@/backend/services/workspace/workspaceMutationGate';
import { assertBundledFlujoWorkloadEffectCurrent } from '@/backend/services/security/bundledFlujoWorkload';
import { conversationJsonChunks, fenceConversationPublication, ConversationPublicationError,
  reserveConversationPublicationScratch, conversationPublicationIsFenced, drainConversationPublicationChildren,
  isConversationPublicationError } from './conversationPublication';

type Intent = { filename: string; live: boolean };
type IntentProcess = { token: string; startedAt: number; live: Set<string> };
const intentHost = globalThis as typeof globalThis & { __flujoPublicationIntentContextV1?: AsyncLocalStorage<Intent>;
  __flujoPublicationIntentProcessV1?: IntentProcess };
const intentContext = intentHost.__flujoPublicationIntentContextV1 ??= new AsyncLocalStorage<Intent>();
// One identity per process (shared by every Next bundle) and the intents it holds right now.
const intentProcess = intentHost.__flujoPublicationIntentProcessV1 ??= {
  token: randomUUID(), startedAt: Date.now() - Math.round(process.uptime() * 1000), live: new Set() };

/** No publication transaction lasts this long; an older intent is abandoned. */
export const ABANDONED_INTENT_AGE_MS = 10 * 60_000;
/** How long to wait for another live FLUJO process to finish the same conversation. */
const FOREIGN_INTENT_WAIT_MS = 15_000;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** An intent whose transaction can never finish: left by a failed attempt in
 * this process, by a process that has exited (crash, update, OOM), or one that
 * is older than any transaction. Only a live writer's intent is respected. */
async function intentIsAbandoned(filename: string): Promise<boolean> {
  if (intentProcess.live.has(filename)) return false;
  let record: { process?: unknown; pid?: unknown; startedAt?: unknown } = {};
  let modifiedAt = 0;
  try {
    modifiedAt = (await fs.stat(filename)).mtimeMs;
    record = JSON.parse(await fs.readFile(filename, 'utf8')) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    // A torn intent (crash between create and write): judge it by its age.
  }
  if (record.process === intentProcess.token) return true;
  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : modifiedAt;
  if (Date.now() - startedAt > ABANDONED_INTENT_AGE_MS) return true;
  // A different token with our pid is a previous instance (containers reuse pids).
  if (typeof record.pid === 'number') return record.pid === process.pid || !processAlive(record.pid);
  // Legacy intents carry no owner: anything older than this process is abandoned.
  return startedAt < intentProcess.startedAt;
}

/** Durable marker spanning one publication transaction. It contains no
 * transcript. A crash leaves it behind; the next writer reclaims it once its
 * owner is gone, and the log writer terminates any torn tail before appending,
 * so a crash never blocks the conversation. */
export async function withConversationPublicationIntent<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const filename = path.join(getWorkspaceDataDir(), 'db', 'conversation-publications', `${conversationId}.json`);
  const inherited = intentContext.getStore();
  if (inherited?.live && inherited.filename === filename) return task();
  await assertCurrent();
  await conversationPublicationIO(() => fs.mkdir(path.dirname(filename), { recursive: true }));
  const parent = await conversationPublicationIO(() => fs.lstat(path.dirname(filename), { bigint: true }));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'publication intent directory is unsafe');
  let handle: FileHandle | undefined;
  const waitUntil = Date.now() + FOREIGN_INTENT_WAIT_MS;
  for (let attempt = 0; !handle; attempt++) {
    try { handle = await fs.open(filename, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'could not create a publication intent', { cause: error });
      }
      if (attempt < 3 && await intentIsAbandoned(filename)) {
        await fs.rm(filename, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= waitUntil) {
        throw new ConversationPublicationError('CONVERSATION_PUBLICATION_BUSY', 'another FLUJO process is still writing this conversation');
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 50 * 2 ** attempt)));
    }
  }
  intentProcess.live.add(filename);
  try { return await underIntent(handle, filename, parent, conversationId, task); }
  finally { intentProcess.live.delete(filename); }
}

async function underIntent<T>(handle: FileHandle, filename: string, parent: BigIntStats, conversationId: string,
  task: () => Promise<T>): Promise<T> {
  let owned: BigIntStats | undefined;
  try {
    owned = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify({ version: 2, conversationId, token: randomUUID(), startedAt: Date.now(),
      pid: process.pid, process: intentProcess.token }));
    await handle.sync();
  } catch (error) {
    try { await handle.close(); } catch { fenceConversationPublication('intent descriptor closure is uncertain', undefined, true, { intent: filename }); }
    throw fenceConversationPublication('publication intent did not finish', error, false, { intent: filename });
  }
  try { await handle.close(); }
  catch (error) { throw fenceConversationPublication('intent descriptor closure is uncertain', error, true, { intent: filename }); }
  const intent = { filename, live: true };
  let primary: unknown;
  try { return await intentContext.run(intent, task); }
  catch (error) {
    primary = error;
    throw primary;
  } finally {
    try { await drainConversationPublicationChildren(); }
    catch (error) { if (primary === undefined) primary = error; }
    intent.live = false;
    if (!conversationPublicationIsFenced()) {
      try {
        await assertCurrent();
        const current = await fs.lstat(filename, { bigint: true });
        const currentParent = await fs.lstat(path.dirname(filename), { bigint: true });
        if (!owned || !sameFile(current, owned) || !currentParent.isDirectory() || currentParent.isSymbolicLink()
          || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) throw new Error('Publication intent identity changed');
        await fs.unlink(filename);
      } catch {
        // The transaction's data is already durable; failing it here would make
        // a retry duplicate it. A leftover intent is reclaimed by the next writer.
      }
    }
    // A detached nested failure is part of this transaction too.
    if (primary !== undefined) throw primary;
  }
}

/** Wrap explicit I/O operations only; never convert the task's primary
 * execution authority or sequence error while cleaning up its intent. */
export async function conversationPublicationIO<T>(task: () => Promise<T>): Promise<T> {
  try { return await task(); }
  catch (error) {
    if (isConversationPublicationError(error) || (error instanceof Error && error.name === 'ConversationSequenceSafetyError')) throw error;
    throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'required durable publication failed', { cause: error });
  }
}

const sameFile = (left: BigIntStats, right: BigIntStats) => left.isFile() && !left.isSymbolicLink()
  && left.nlink === BigInt(1) && left.dev === right.dev && left.ino === right.ino;
const sameVersion = (left: BigIntStats, right: BigIntStats) => sameFile(left, right)
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
async function assertCurrent(): Promise<void> {
  await assertWorkspaceMutationOwned();
  await assertBundledFlujoWorkloadEffectCurrent();
}

export interface ConversationLogWriter {
  append(events: Iterable<unknown>): Promise<void>;
  rollback(): Promise<void>;
  activeMessageIds(): Promise<string[]>;
}

/** One owned descriptor from inspection through append, snapshot, and optional
 * rollback. No old-log string or copy is retained. */
export async function withConversationLogWriter<T>(filename: string, task: (writer: ConversationLogWriter) => Promise<T>): Promise<T> {
  await assertCurrent();
  const directory = path.dirname(filename);
  await conversationPublicationIO(() => fs.mkdir(directory, { recursive: true }));
  const parent = await conversationPublicationIO(() => fs.lstat(directory, { bigint: true }));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'conversation log directory is unsafe');
  const handle = await conversationPublicationIO(() => fs.open(filename, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600));
  let receipt: Record<string, string> = { filename };
  try {
    const original = await conversationPublicationIO(() => handle.stat({ bigint: true }));
    if (!original.isFile() || original.nlink !== BigInt(1) || original.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'conversation log is not a regular owned file');
    }
    let witness = original;
    let position = Number(original.size);
    receipt = { filename, dev: String(original.dev), ino: String(original.ino), start: String(original.size) };
    const verify = async () => {
      const named = await conversationPublicationIO(() => fs.lstat(filename, { bigint: true }));
      const current = await conversationPublicationIO(() => handle.stat({ bigint: true }));
      const currentParent = await conversationPublicationIO(() => fs.lstat(directory, { bigint: true }));
      if (!sameVersion(current, witness) || !sameVersion(named, witness)
        || !currentParent.isDirectory() || currentParent.isSymbolicLink()
        || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) {
        throw fenceConversationPublication('conversation log identity or appended suffix changed', undefined, false, receipt);
      }
      await assertCurrent();
    };
    await verify();
    // A crash can leave a torn final record. Start on a fresh line so it stays
    // one isolated, skipped line instead of swallowing the first new event.
    let separator = false;
    if (position > 0) {
      const tail = Buffer.alloc(1);
      const { bytesRead } = await conversationPublicationIO(() => handle.read(tail, 0, 1, position - 1));
      separator = bytesRead === 1 && tail[0] !== 0x0a;
    }
    const tornTail = separator;
    const writeAll = async (bytes: Uint8Array) => {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset, position);
        if (!result.bytesWritten) throw new Error('Conversation log made no write progress');
        offset += result.bytesWritten; position += result.bytesWritten;
      }
    };
    // This descriptor knows exactly where its own append began, so removing a
    // failed suffix is not a guess. A rolled-back append can simply be retried.
    const rollbackAppend = async (to: number): Promise<boolean> => {
      try {
        const current = await handle.stat({ bigint: true });
        if (!sameFile(current, original) || current.size < BigInt(to)) return false;
        if (current.size !== BigInt(to)) { await handle.truncate(to); await handle.sync(); }
        witness = await handle.stat({ bigint: true });
        position = to;
        return witness.size === BigInt(to);
      } catch { return false; }
    };
    const writer: ConversationLogWriter = {
      activeMessageIds: () => conversationPublicationIO(() => readActiveMessageIds(handle, Number(original.size))),
      append: async events => {
        await verify();
        const appendStart = position;
        try {
          if (separator) await writeAll(Buffer.from('\n'));
          for (const bytes of conversationJsonChunks(events, true)) await writeAll(bytes);
          await handle.sync();
          witness = await handle.stat({ bigint: true });
          if (!sameFile(witness, original) || witness.size !== BigInt(position)) {
            throw fenceConversationPublication('conversation append completion has no owned suffix witness', undefined, false, receipt);
          }
          await verify();
          separator = false;
        } catch (error) {
          if (await rollbackAppend(appendStart)) {
            throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'conversation append did not finish and was rolled back', { cause: error });
          }
          // Keep an unremovable suffix; the next writer starts on a fresh line.
          throw fenceConversationPublication('conversation append outcome requires reconciliation', error, false, { ...receipt, acknowledgedEnd: String(position) });
        }
      },
      rollback: async () => {
        await verify();
        try {
          await handle.truncate(Number(original.size));
          await handle.sync();
          witness = await handle.stat({ bigint: true });
          if (!sameFile(witness, original) || witness.size !== original.size) throw new Error('Rollback size changed');
          position = Number(original.size); separator = tornTail;
          await verify();
        } catch (error) { throw fenceConversationPublication('conversation rollback requires reconciliation', error, false, receipt); }
      },
    };
    return await task(writer);
  } finally {
    // Appends are synced before this point; a failed close cannot undo them, and
    // failing here would make a retry duplicate a durable append.
    try { await handle.close(); } catch { /* descriptor is released with the process */ }
  }
}

/** Keep JSON grammar and short metadata, replacing long string tokens before
 * JSON.parse. Large content, tool arguments, and resource text never become a
 * second full string or parsed message. Per-line scratch and projected IDs are
 * bounded independently of the file length. */
async function readActiveMessageIds(handle: FileHandle, size: number): Promise<string[]> {
  reserveConversationPublicationScratch(32 * 1024 * 1024);
  const maxLineChars = 1024 * 1024, maxIds = 65_536, maxIdChars = 4096;
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  const ids = new Set<string>(), occurrences = new Map<string, number>();
  let parts: string[] = [], part = '', lineChars = 0, token = '', inString = false, escaped = false, dropped = false, idChars = 0;
  let pendingDrop = false, invalid = false, unicodeLeft = 0, historicalIdChars = 0, depth = 0, tokens = 0;
  const limit = () => { throw new ConversationPublicationError('CONVERSATION_PUBLICATION_MEMORY', 'transcript metadata exceeds its bounded rewrite policy'); };
  const resetLine = () => { parts = []; part = ''; lineChars = 0; depth = 0; tokens = 0; };
  const emit = (text: string) => {
    if (lineChars + text.length > maxLineChars) limit();
    lineChars += text.length;
    for (let start = 0; start < text.length;) {
      const count = Math.min(4096 - part.length, text.length - start);
      part += text.slice(start, start + count); start += count;
      if (part.length === 4096) {
        // Flatten bounded ropes as they fill, rather than retaining one cons
        // node per byte for a metadata-dense historical record.
        parts.push(Buffer.from(part, 'utf16le').toString('utf16le')); part = '';
      }
    }
  };
  const finish = () => {
    if (invalid) { invalid = false; resetLine(); return; }
    if (part) parts.push(part);
    const line = parts.join(''); resetLine();
    if (!line.trim()) return;
    let event: { type?: unknown; messageId?: unknown; message?: { id?: unknown; role?: unknown } };
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'message' && event.message && event.message.role !== 'system') {
      const rawId = event.message.id;
      // A discarded long ID is distinguishable from a legitimate empty ID.
      if (rawId === null) limit();
      if (typeof rawId !== 'string' || !rawId) return;
      if (rawId.length > maxIdChars) limit();
      let id = rawId;
      if (ids.has(id) && /^stream_codex_item_/.test(id)) {
        const count = (occurrences.get(id) ?? 1) + 1;
        occurrences.set(id, count); id = `${id}_legacy_${count}`;
      } else if (!occurrences.has(id)) {
        historicalIdChars += id.length;
        if (historicalIdChars > 1024 * 1024) limit();
        occurrences.set(id, 1);
      }
      if (!ids.has(id)) { ids.add(id); idChars += id.length; }
      if (ids.size > maxIds || occurrences.size > maxIds || idChars > 1024 * 1024) limit();
    } else if (event?.type === 'message:removed') {
      if (event.messageId === null) limit();
      if (typeof event.messageId === 'string' && ids.delete(event.messageId)) idChars -= event.messageId.length;
    }
  };
  const accept = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (pendingDrop) {
        if (char === ' ' || char === '\t' || char === '\r') continue;
        emit(char === ':' ? '""' : 'null'); pendingDrop = false;
      }
      if (char === '\n') {
        if (!inString) finish();
        else { resetLine(); invalid = false; } // Raw newline invalidates this record.
        inString = false; escaped = false; token = ''; dropped = false; unicodeLeft = 0;
        continue;
      }
      if (!inString) {
        if (char === '{' || char === '[') { if (++depth > 128) limit(); }
        else if (char === '}' || char === ']') depth--;
        if ('{[,"'.includes(char) && ++tokens > 262_144) limit();
        if (char === '"') { inString = true; token = '"'; dropped = false; }
        else emit(char);
        continue;
      }
      if (!dropped) { token += char; if (token.length > maxIdChars * 6 + 2) { dropped = true; token = ''; } }
      if (unicodeLeft) {
        if (!/[0-9a-f]/i.test(char)) invalid = true;
        unicodeLeft--;
      } else if (escaped) {
        escaped = false;
        if (char === 'u') unicodeLeft = 4;
        else if (!'"\\/bfnrt'.includes(char)) invalid = true;
      }
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; if (dropped) pendingDrop = true; else emit(token); token = ''; }
      else if (char.charCodeAt(0) < 32) invalid = true;
    }
  };
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error('Conversation log changed while reading rewrite metadata');
    offset += bytesRead; accept(decoder.write(buffer.subarray(0, bytesRead)));
  }
  accept(decoder.end()); if (pendingDrop) emit('null'); if (!inString) finish();
  return [...ids];
}
