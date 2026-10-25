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
const intentHost = globalThis as typeof globalThis & { __flujoPublicationIntentContextV1?: AsyncLocalStorage<Intent> };
const intentContext = intentHost.__flujoPublicationIntentContextV1 ??= new AsyncLocalStorage<Intent>();

/** A crash or unknown commit must remain fenced after process restart. This
 * small, durable intent contains no transcript; its exclusive filename is the
 * restart fence until reconciliation has verified the snapshot and log. */
export async function withConversationPublicationIntent<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const filename = path.join(getWorkspaceDataDir(), 'db', 'conversation-publications', `${conversationId}.json`);
  const inherited = intentContext.getStore();
  if (inherited?.live && inherited.filename === filename) return task();
  await assertCurrent();
  await conversationPublicationIO(() => fs.mkdir(path.dirname(filename), { recursive: true }));
  const parent = await conversationPublicationIO(() => fs.lstat(path.dirname(filename), { bigint: true }));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'publication intent directory is unsafe');
  let handle: FileHandle;
  try { handle = await fs.open(filename, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw fenceConversationPublication('an unfinished durable publication requires reconciliation', error, false, { intent: filename });
    }
    throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'could not create a publication intent', { cause: error });
  }
  let owned: BigIntStats | undefined;
  try {
    owned = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify({ version: 1, conversationId, token: randomUUID(), startedAt: Date.now() }));
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
      } catch (error) {
        const uncertain = fenceConversationPublication('publication intent cleanup requires reconciliation', error, false, { intent: filename });
        if (primary === undefined) throw uncertain;
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
 * rollback. No old-log string or copy is retained. Close uncertainty occupies
 * the publisher's finite descriptor slot before another writer may open. */
export async function withConversationLogWriter<T>(filename: string, task: (writer: ConversationLogWriter) => Promise<T>): Promise<T> {
  await assertCurrent();
  const directory = path.dirname(filename);
  await conversationPublicationIO(() => fs.mkdir(directory, { recursive: true }));
  const parent = await conversationPublicationIO(() => fs.lstat(directory, { bigint: true }));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ConversationPublicationError('CONVERSATION_PUBLICATION_IO', 'conversation log directory is unsafe');
  const handle = await conversationPublicationIO(() => fs.open(filename, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600));
  let primary: unknown;
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
    const writer: ConversationLogWriter = {
      activeMessageIds: () => conversationPublicationIO(() => readActiveMessageIds(handle, Number(original.size))),
      append: async events => {
        await verify();
        try {
          for (const bytes of conversationJsonChunks(events, true)) {
            let offset = 0;
            while (offset < bytes.length) {
              const result = await handle.write(bytes, offset, bytes.length - offset, position);
              if (!result.bytesWritten) throw new Error('Conversation log made no write progress');
              offset += result.bytesWritten; position += result.bytesWritten;
            }
          }
          await handle.sync();
          witness = await handle.stat({ bigint: true });
          if (!sameFile(witness, original) || witness.size !== BigInt(position)) {
            throw fenceConversationPublication('conversation append completion has no owned suffix witness', undefined, false, receipt);
          }
          await verify();
        } catch (error) {
          // A rejected write can have written bytes. Keep the suffix for
          // reconciliation instead of guessing an offset and deleting it.
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
          position = Number(original.size);
          await verify();
        } catch (error) { throw fenceConversationPublication('conversation rollback requires reconciliation', error, false, receipt); }
      },
    };
    return await task(writer);
  } catch (error) { primary = error; throw error; }
  finally {
    try { await handle.close(); }
    catch (error) {
      const uncertain = fenceConversationPublication('conversation log descriptor closure is uncertain', error, true, receipt);
      if (primary === undefined) throw uncertain;
    }
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
