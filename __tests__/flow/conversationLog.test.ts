/**
 * execution-core-v2 Phase 3 — append-only conversation log + projection.
 *
 * The log is the per-conversation source of truth: every persisted step is an
 * APPEND (one JSONL line), and the displayed conversation is a pure fold of
 * 'message' / 'message:removed' events (upsert by id, system-role excluded,
 * subflow steps tagged with depth). These tests pin:
 *  - the store: append order, ephemeral refusal (policy chokepoint), unknown-
 *    conversation refusal, truncated-tail tolerance, idempotent delete;
 *  - the projection: upsert-by-id, system exclusion, depth tagging, removal.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  appendFromBus,
  appendRawForState,
  readConversationLog,
  deleteConversationLog,
  hasConversationLog,
  flushConversationLog,
  projectMessages,
  recoverMessagesFromLog,
  _setConversationLogDirForTests,
} from '@/backend/execution/flow/conversationLog';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import type { ExecutionEvent, MessageEvent } from '@/shared/types/execution/events';
import type { FlujoChatMessage } from '@/shared/types/chat';

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-convlog-'));
  previousDir = _setConversationLogDirForTests(tmpDir);
});

afterAll(async () => {
  _setConversationLogDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  FlowExecutor.conversationStates.clear();
});

const makeState = (conversationId: string, ephemeral = false): SharedState =>
  ({
    trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId,
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    ...(ephemeral ? { ephemeral: true } : {}),
  } as SharedState);

const msg = (id: string, role: FlujoChatMessage['role'], content = id): FlujoChatMessage =>
  ({ role, content, id, timestamp: 1 } as FlujoChatMessage);

const messageEvent = (
  conversationId: string,
  message: FlujoChatMessage,
  overrides: Partial<MessageEvent> = {}
): ExecutionEvent =>
  ({ type: 'message', conversationId, seq: 0, timestamp: 1, message, ...overrides } as ExecutionEvent);

describe('conversation log store', () => {
  it('appends persisted-type events from the bus in order and reads them back', async () => {
    const convId = 'conv-store-order';
    FlowExecutor.conversationStates.set(convId, makeState(convId));

    appendFromBus({ type: 'run:start', conversationId: convId, seq: 0, timestamp: 1, flowId: 'flow-1' } as ExecutionEvent);
    appendFromBus(messageEvent(convId, msg('m1', 'user')));
    appendFromBus({ type: 'run:done', conversationId: convId, seq: 2, timestamp: 3, status: 'completed' } as ExecutionEvent);
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    expect(events?.map((e) => e.type)).toEqual(['run:start', 'message', 'run:done']);
  });

  it('filters transient event types (model:delta, run:paused) out of the log', async () => {
    const convId = 'conv-store-filter';
    FlowExecutor.conversationStates.set(convId, makeState(convId));

    appendFromBus({ type: 'model:delta', conversationId: convId, seq: 0, timestamp: 1, delta: 'x' } as ExecutionEvent);
    appendFromBus({ type: 'run:paused', conversationId: convId, seq: 1, timestamp: 1, reason: 'debug' } as ExecutionEvent);
    appendFromBus(messageEvent(convId, msg('m1', 'assistant')));
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    expect(events?.map((e) => e.type)).toEqual(['message']);
  });

  it('REFUSES to persist events for an ephemeral state (policy chokepoint)', async () => {
    const convId = 'conv-store-ephemeral';
    FlowExecutor.conversationStates.set(convId, makeState(convId, true));

    appendFromBus(messageEvent(convId, msg('m1', 'user')));
    await flushConversationLog(convId);

    expect(await hasConversationLog(convId)).toBe(false);
    expect(await readConversationLog(convId)).toBeUndefined();
  });

  it('REFUSES to persist events for a conversation with no registered state (safe default)', async () => {
    const convId = 'conv-store-unknown';
    appendFromBus(messageEvent(convId, msg('m1', 'user')));
    await flushConversationLog(convId);
    expect(await hasConversationLog(convId)).toBe(false);
  });

  it('refuses unsafe conversation ids (no path escape)', async () => {
    const evil = '..\\..\\evil';
    appendFromBus(messageEvent(evil, msg('m1', 'user')));
    await flushConversationLog(evil);
    expect(await hasConversationLog(evil)).toBe(false);
  });

  it('appendRawForState stamps log-only events with seq -1 and refuses ephemeral states', async () => {
    const convId = 'conv-store-raw';
    const state = makeState(convId);
    await appendRawForState(state, [
      { type: 'message', message: msg('m1', 'user') },
      { type: 'message:removed', messageId: 'gone' },
    ]);

    const events = await readConversationLog(convId);
    expect(events?.map((e) => [e.type, e.seq])).toEqual([
      ['message', -1],
      ['message:removed', -1],
    ]);

    const ephemeralState = makeState('conv-store-raw-eph', true);
    await appendRawForState(ephemeralState, [{ type: 'message', message: msg('m2', 'user') }]);
    expect(await hasConversationLog('conv-store-raw-eph')).toBe(false);
  });

  it('tolerates a truncated tail line (crash mid-append)', async () => {
    const convId = 'conv-store-truncated';
    const state = makeState(convId);
    await appendRawForState(state, [
      { type: 'message', message: msg('m1', 'user') },
      { type: 'message', message: msg('m2', 'assistant') },
    ]);
    // Simulate a crash mid-append: a dangling half-written JSON line.
    await fs.appendFile(path.join(tmpDir, `${convId}.jsonl`), '{"type":"mess');

    const events = await readConversationLog(convId);
    expect(events?.map((e) => (e as MessageEvent).message.id)).toEqual(['m1', 'm2']);
  });

  it('returns undefined for a conversation with no log (legacy fallback signal)', async () => {
    expect(await readConversationLog('conv-never-logged')).toBeUndefined();
  });

  it('deleteConversationLog removes the file and is idempotent', async () => {
    const convId = 'conv-store-delete';
    await appendRawForState(makeState(convId), [{ type: 'message', message: msg('m1', 'user') }]);
    expect(await hasConversationLog(convId)).toBe(true);

    await deleteConversationLog(convId);
    expect(await hasConversationLog(convId)).toBe(false);
    await expect(deleteConversationLog(convId)).resolves.toBeUndefined(); // second delete: no throw
  });
});

describe('projectMessages (conversation-as-projection)', () => {
  const convId = 'conv-projection';

  it('folds message events in order, excluding system-role messages', () => {
    const projected = projectMessages([
      messageEvent(convId, msg('sys', 'system', 'node prompt')),
      messageEvent(convId, msg('u1', 'user', 'hi')),
      messageEvent(convId, msg('a1', 'assistant', 'hello')),
    ]);
    expect(projected.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('upserts by message id: a re-emitted message replaces the earlier copy IN PLACE', () => {
    // Streamed live mid-run, then materialized (same id, final content) at step
    // end — and edited via edit-state later. Last event wins, position kept.
    const projected = projectMessages([
      messageEvent(convId, msg('u1', 'user')),
      messageEvent(convId, msg('a1', 'assistant', 'partial…')),
      messageEvent(convId, msg('u2', 'user')),
      messageEvent(convId, msg('a1', 'assistant', 'final answer')),
    ]);
    expect(projected.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(projected[1].content).toBe('final answer');
  });

  it('tags subflow child messages (event depth > 0) with depth, inlined in order', () => {
    const projected = projectMessages([
      messageEvent(convId, msg('u1', 'user', 'task')),
      messageEvent(convId, msg('c1', 'assistant', 'child step'), { depth: 1 }),
      messageEvent(convId, msg('a1', 'assistant', 'folded output')),
    ]);
    expect(projected.map((m) => [m.id, m.depth ?? 0])).toEqual([
      ['u1', 0],
      ['c1', 1],
      ['a1', 0],
    ]);
  });

  it('message:removed deletes and later upserts still land at the right place', () => {
    const projected = projectMessages([
      messageEvent(convId, msg('u1', 'user')),
      messageEvent(convId, msg('a1', 'assistant')),
      messageEvent(convId, msg('u2', 'user')),
      { type: 'message:removed', conversationId: convId, seq: -1, timestamp: 2, messageId: 'a1' } as ExecutionEvent,
      messageEvent(convId, msg('u2', 'user', 'edited')), // upsert after a removal shifted indices
    ]);
    expect(projected.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(projected[1].content).toBe('edited');
  });

  it('removal of an unknown id is a no-op', () => {
    const projected = projectMessages([
      messageEvent(convId, msg('u1', 'user')),
      { type: 'message:removed', conversationId: convId, seq: -1, timestamp: 2, messageId: 'nope' } as ExecutionEvent,
    ]);
    expect(projected.map((m) => m.id)).toEqual(['u1']);
  });
});

describe('recoverMessagesFromLog (crash recovery: snapshot behind the log)', () => {
  // Per-step durability is the log; the SharedState snapshot is only written
  // at run boundaries. A crash mid-run leaves the snapshot missing messages
  // that ARE in the log — recovery adopts the log's parent-level projection
  // when (and only when) it strictly extends the snapshot.

  it('folds log messages missing from a stale snapshot back into the state', async () => {
    const convId = 'conv-recover-stale';
    const state = makeState(convId);
    state.messages = [msg('u1', 'user', 'task')];
    await appendRawForState(state, [
      { type: 'message', message: msg('u1', 'user', 'task') },
      { type: 'message', message: msg('a1', 'assistant', 'streamed mid-run') },
      { type: 'message', message: msg('t1', 'tool', 'tool result') },
    ]);

    const recovered = await recoverMessagesFromLog(state);
    expect(recovered).toBe(true);
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
  });

  it('excludes depth>0 subflow steps from recovery (display-only, never transcript)', async () => {
    const convId = 'conv-recover-depth';
    const state = makeState(convId);
    state.messages = [msg('u1', 'user')];
    await appendRawForState(state, [
      { type: 'message', message: msg('u1', 'user') },
      { type: 'message', message: { ...msg('c1', 'assistant', 'child step'), depth: 1 }, depth: 1 },
      { type: 'message', message: msg('a1', 'assistant', 'answer') },
    ]);

    expect(await recoverMessagesFromLog(state)).toBe(true);
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('keeps the snapshot when the log does not strictly extend it (no log / diverged / equal)', async () => {
    // No log at all.
    const noLog = makeState('conv-recover-nolog');
    noLog.messages = [msg('u1', 'user')];
    expect(await recoverMessagesFromLog(noLog)).toBe(false);
    expect(noLog.messages.map((m) => m.id)).toEqual(['u1']);

    // Log diverged: snapshot has a message the log lacks.
    const diverged = makeState('conv-recover-diverged');
    diverged.messages = [msg('u1', 'user'), msg('local-only', 'assistant')];
    await appendRawForState(diverged, [
      { type: 'message', message: msg('u1', 'user') },
      { type: 'message', message: msg('a1', 'assistant') },
    ]);
    expect(await recoverMessagesFromLog(diverged)).toBe(false);
    expect(diverged.messages.map((m) => m.id)).toEqual(['u1', 'local-only']);

    // Log equal to snapshot: nothing to recover.
    const equal = makeState('conv-recover-equal');
    equal.messages = [msg('u1', 'user')];
    await appendRawForState(equal, [{ type: 'message', message: msg('u1', 'user') }]);
    expect(await recoverMessagesFromLog(equal)).toBe(false);
  });

  it('ignores a leading legacy system message when comparing (recovery still applies)', async () => {
    const convId = 'conv-recover-system';
    const state = makeState(convId);
    state.messages = [msg('sys', 'system', 'old node prompt'), msg('u1', 'user')];
    await appendRawForState(state, [
      { type: 'message', message: msg('u1', 'user') },
      { type: 'message', message: msg('a1', 'assistant') },
    ]);

    expect(await recoverMessagesFromLog(state)).toBe(true);
    // Recovery adopts the projection (system-free, like every post-Phase-3 state).
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });
});
