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
  repairDanglingToolCalls,
  INTERRUPTED_TOOL_RESULT_CONTENT,
  repairTruncatedConversationLog,
  allocateSeq,
  latestSequence,
  _setConversationLogDirForTests,
} from '@/backend/execution/flow/conversationLog';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
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

    appendFromBus({ type: 'model:delta', conversationId: convId, seq: 0, timestamp: 1, messageId: 'draft-1', delta: 'x' } as ExecutionEvent);
    appendFromBus({ type: 'run:paused', conversationId: convId, seq: 1, timestamp: 1, reason: 'debug' } as ExecutionEvent);
    appendFromBus(messageEvent(convId, msg('m1', 'assistant')));
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    expect(events?.map((e) => e.type)).toEqual(['message']);
  });

  it('persists resource:read / resource:write events (Tier 3 lineage)', async () => {
    const convId = 'conv-store-resources';
    FlowExecutor.conversationStates.set(convId, makeState(convId));

    appendFromBus({
      type: 'resource:write', conversationId: convId, seq: 0, timestamp: 1,
      server: 'flujo', uri: `flujo://run/${convId}/r1`, source: 'tool-result', toolCallId: 'c1',
    } as ExecutionEvent);
    appendFromBus({
      type: 'resource:read', conversationId: convId, seq: 1, timestamp: 2,
      server: 'flujo', uri: `flujo://run/${convId}/r1`, source: 'pill',
    } as ExecutionEvent);
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    expect(events?.map((e) => e.type)).toEqual(['resource:write', 'resource:read']);
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
      ['message', 0],
      ['message:removed', 1],
    ]);

    const ephemeralState = makeState('conv-store-raw-eph', true);
    await appendRawForState(ephemeralState, [{ type: 'message', message: msg('m2', 'user') }]);
    expect(await hasConversationLog('conv-store-raw-eph')).toBe(false);
  });

  it('does not append authoritative transcript events after a Persona commit fence is lost', async () => {
    const convId = 'conv-store-stale-persona';
    const state = makeState(convId);
    state.personaAttribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'behavior-revision-1',
    };
    const leaseLost = new Error('Persona lease is no longer current');
    const commitWhileCurrent = jest.fn(async () => {
      throw leaseLost;
    });
    state.executionAuthority = {
      assertCurrent: jest.fn(async () => undefined),
      signal: new AbortController().signal,
      commitWhileCurrent,
    };

    await expect(appendRawForState(state, [
      { type: 'message', message: msg('late-model-response', 'assistant') },
    ])).rejects.toBe(leaseLost);
    expect(commitWhileCurrent).toHaveBeenCalledTimes(1);
    expect(await readConversationLog(convId)).toBeUndefined();
  });

  it('fails closed when Persona attribution is loaded without its runtime capability', async () => {
    const convId = 'conv-store-unfenced-persona';
    const state = makeState(convId);
    state.personaAttribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'behavior-revision-1',
    };

    await expect(appendRawForState(state, [
      { type: 'message', message: msg('unfenced-response', 'assistant') },
    ])).rejects.toThrow('requires current execution authority');
    expect(await readConversationLog(convId)).toBeUndefined();
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

  it('preserves distinct messages that reused legacy Codex SDK-local item ids', () => {
    const legacyId = 'stream_codex_item_0';
    const projected = projectMessages([
      messageEvent(convId, msg(legacyId, 'assistant', 'first model turn')),
      messageEvent(convId, msg('tool-pair', 'assistant', 'between turns')),
      messageEvent(convId, msg(legacyId, 'assistant', 'second model turn')),
      messageEvent(convId, msg(legacyId, 'assistant', 'third model turn')),
    ]);

    expect(projected.map((message) => message.id)).toEqual([
      legacyId,
      'tool-pair',
      `${legacyId}_legacy_2`,
      `${legacyId}_legacy_3`,
    ]);
    expect(projected.map((message) => message.content)).toEqual([
      'first model turn',
      'between turns',
      'second model turn',
      'third model turn',
    ]);
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

describe('FlowExecutor.conversationStates is global-backed (issue #49 root cause)', () => {
  // The conversation-log bus tap resolves the ephemeral policy via
  // FlowExecutor.conversationStates. That map used to be a per-instance static,
  // so a planned run registered in the scheduler instance was invisible to the
  // global-bus tap in another Next.js module instance — every bus event was
  // dropped. Global-backing makes it ONE map, so a state registered through the
  // globalThis handle is seen by the tap and its events persist.
  it('shares one map via globalThis so a bus event for a registered state persists', async () => {
    expect(FlowExecutor.conversationStates).toBe(
      (globalThis as unknown as { __flujo_conversation_states?: unknown }).__flujo_conversation_states
    );

    const convId = 'conv-global-backed';
    // Register the state through the raw global handle (as a different module
    // instance's scheduler would), NOT through FlowExecutor directly.
    (globalThis as unknown as { __flujo_conversation_states: Map<string, SharedState> })
      .__flujo_conversation_states.set(convId, makeState(convId));

    appendFromBus(messageEvent(convId, msg('m1', 'assistant', 'from a scheduler run')));
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    expect(events?.map((e) => (e as MessageEvent).message.id)).toEqual(['m1']);
  });
});

describe('repairTruncatedConversationLog (issue #49: log behind the snapshot)', () => {
  // The inverse of recoverMessagesFromLog. A planned run whose bus events were
  // dropped keeps a COMPLETE .json snapshot but a TRUNCATED .jsonl (often just
  // the turn-start reconcile line). Because the display route prefers the
  // projection, it renders one message until the log is rebuilt.

  it('rebuilds the log from the snapshot when the projection is a strict truncated subset', async () => {
    const convId = 'conv-repair-truncated';
    // Truncated log: only the first (reconcile) message survived.
    await appendRawForState(makeState(convId), [{ type: 'message', message: msg('u1', 'user') }]);

    // Authoritative snapshot has the full transcript.
    const state = makeState(convId);
    state.messages = [msg('u1', 'user'), msg('a1', 'assistant', 'answer'), msg('u2', 'user', 'thanks')];

    const repaired = await repairTruncatedConversationLog(state);
    expect(repaired?.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);

    // The log itself is rebuilt so future reads project the full transcript.
    await flushConversationLog(convId);
    const events = await readConversationLog(convId);
    expect(projectMessages(events!).map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('does nothing when the log is level with or ahead of the snapshot', async () => {
    const convId = 'conv-repair-level';
    await appendRawForState(makeState(convId), [{ type: 'message', message: msg('u1', 'user') }]);
    const state = makeState(convId);
    state.messages = [msg('u1', 'user')];
    expect(await repairTruncatedConversationLog(state)).toBeUndefined();
  });

  it('does not clobber a legitimately diverged log (projected id absent from snapshot)', async () => {
    const convId = 'conv-repair-diverged';
    // Log holds a message the snapshot no longer has (edited/pruned history).
    await appendRawForState(makeState(convId), [{ type: 'message', message: msg('x1', 'user') }]);
    const state = makeState(convId);
    state.messages = [msg('u1', 'user'), msg('a1', 'assistant')]; // shorter projection but NOT a subset

    expect(await repairTruncatedConversationLog(state)).toBeUndefined();
    // Log untouched.
    const events = await readConversationLog(convId);
    expect(events?.map((e) => (e as MessageEvent).message.id)).toEqual(['x1']);
  });

  it('never rewrites an ephemeral state', async () => {
    const convId = 'conv-repair-ephemeral';
    const eph = makeState(convId, true);
    eph.messages = [msg('u1', 'user'), msg('a1', 'assistant')];
    expect(await repairTruncatedConversationLog(eph)).toBeUndefined();
    expect(await hasConversationLog(convId)).toBe(false);
  });
});

describe('authoritative monotonic seq (issue #261)', () => {
  it('keeps seq strictly monotonic across a channel GC cycle (never resets to 0)', () => {
    const convId = 'conv-seq-gc';
    const e0 = executionEventBus.emit(convId, { type: 'run:start', flowId: 'f' } as any);
    const e1 = executionEventBus.emit(convId, { type: 'usage', totalTokens: 1 } as any);
    // Simulate the channel (and its ring buffer) being garbage-collected 5 min
    // after run:done — historically this reset the bus seq to 0.
    (executionEventBus as unknown as { channels: Map<string, unknown> }).channels.delete(convId);
    const e2 = executionEventBus.emit(convId, { type: 'run:start', flowId: 'f' } as any);
    const e3 = executionEventBus.emit(convId, { type: 'usage', totalTokens: 2 } as any);
    expect([e0.seq, e1.seq, e2.seq, e3.seq]).toEqual([0, 1, 2, 3]);
  });

  it('stamps appendRawForState (log-only) events with real monotonic seqs, never -1', async () => {
    const convId = 'conv-seq-raw';
    const state = makeState(convId);
    await appendRawForState(state, [
      { type: 'message', message: msg('u1', 'user') },
      { type: 'message', message: msg('a1', 'assistant') },
    ]);
    await flushConversationLog(convId);
    const events = await readConversationLog(convId);
    expect(events?.map((e) => e.seq)).toEqual([0, 1]);
    expect(events?.every((e) => e.seq >= 0)).toBe(true);
  });

  it('latestSequence matches the last appended event after flush', async () => {
    const convId = 'conv-seq-latest';
    const state = makeState(convId);
    expect(await latestSequence(convId)).toBe(-1); // nothing persisted yet
    await appendRawForState(state, [
      { type: 'message', message: msg('u1', 'user') },
      { type: 'message', message: msg('a1', 'assistant') },
      { type: 'message', message: msg('a2', 'assistant') },
    ]);
    await flushConversationLog(convId);
    expect(await latestSequence(convId)).toBe(2);
  });

  it('cold-start seeds the counter at max(seq)+1 from an existing file (legacy -1 and non-monotonic tolerated)', async () => {
    const convId = 'conv-seq-coldstart';
    const legacy = [
      { type: 'message', conversationId: convId, seq: -1, timestamp: 1, message: msg('u1', 'user') },
      { type: 'message', conversationId: convId, seq: 7, timestamp: 1, message: msg('a1', 'assistant') },
      { type: 'message', conversationId: convId, seq: 3, timestamp: 1, message: msg('a2', 'assistant') },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join('');
    await fs.writeFile(path.join(tmpDir, `${convId}.jsonl`), legacy);
    // First allocation resumes just past the highest authoritative seq (7), it
    // does NOT reset to 0 or trip over the legacy -1.
    expect(allocateSeq(convId)).toBe(8);
    expect(allocateSeq(convId)).toBe(9);
    expect(await latestSequence(convId)).toBe(9);
  });

  it('append order equals seq order (interleaved bus + log-only appends)', async () => {
    const convId = 'conv-seq-order';
    const state = makeState(convId);
    FlowExecutor.conversationStates.set(convId, state);
    executionEventBus.emit(convId, { type: 'run:start', flowId: 'f' } as any); // seq 0
    await appendRawForState(state, [{ type: 'message', message: msg('u1', 'user') }]); // seq 1
    executionEventBus.emit(convId, {
      type: 'message',
      message: msg('a1', 'assistant'),
    } as any); // seq 2
    await flushConversationLog(convId);
    const events = await readConversationLog(convId);
    const seqs = events!.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // file order === seq order
    expect(seqs).toEqual([0, 1, 2]);
  });
});

// Issue #256 — reconcile dangling tool calls at run start / load / cancel.
const asstToolCall = (
  id: string,
  toolCallIds: string[],
  overrides: Partial<FlujoChatMessage> = {}
): FlujoChatMessage =>
  ({
    role: 'assistant',
    content: null,
    tool_calls: toolCallIds.map((tid) => ({
      id: tid,
      type: 'function',
      function: { name: 'do_thing', arguments: '{}' },
    })),
    id,
    timestamp: 1,
    ...overrides,
  } as FlujoChatMessage);

const toolResult = (id: string, toolCallId: string): FlujoChatMessage =>
  ({ role: 'tool', tool_call_id: toolCallId, content: 'ok', id, timestamp: 1 } as FlujoChatMessage);

describe('repairDanglingToolCalls (issue #256)', () => {
  it('synthesizes one result per unanswered tool_call_id at the end of a turn', () => {
    const convId = 'conv-repair-basic';
    const state = makeState(convId);
    state.messages = [
      msg('u1', 'user'),
      asstToolCall('a1', ['call_1', 'call_2'], { processNodeId: 'node-x' }),
    ];

    const synthesized = repairDanglingToolCalls(state);

    expect(synthesized).toHaveLength(2);
    expect(synthesized.map((m) => (m as any).tool_call_id).sort()).toEqual(['call_1', 'call_2']);
    for (const m of synthesized) {
      expect(m.role).toBe('tool');
      expect(m.content).toBe(INTERRUPTED_TOOL_RESULT_CONTENT);
      expect(m.id).toBeTruthy();
      expect((m as any).processNodeId).toBe('node-x'); // carried over from the assistant turn
    }
    // Inserted right after the owning assistant turn.
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
  });

  it('only answers the calls that lack a result (mixed case), preserving existing results', () => {
    const convId = 'conv-repair-mixed';
    const state = makeState(convId);
    state.messages = [
      asstToolCall('a1', ['call_1', 'call_2']),
      toolResult('t1', 'call_1'),
    ];

    const synthesized = repairDanglingToolCalls(state);

    expect(synthesized).toHaveLength(1);
    expect((synthesized[0] as any).tool_call_id).toBe('call_2');
    // Existing result kept; synthetic appended after the existing result block.
    expect(state.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool']);
    expect((state.messages[1] as any).tool_call_id).toBe('call_1'); // original untouched
    expect((state.messages[2] as any).tool_call_id).toBe('call_2'); // synthetic
  });

  it('is a no-op when every tool call is already answered', () => {
    const convId = 'conv-repair-noop';
    const state = makeState(convId);
    const before: FlujoChatMessage[] = [
      asstToolCall('a1', ['call_1']),
      toolResult('t1', 'call_1'),
    ];
    state.messages = [...before];

    const synthesized = repairDanglingToolCalls(state);

    expect(synthesized).toEqual([]);
    expect(state.messages).toEqual(before); // untouched
  });

  it('accepts a cause-specific message (cancellation path)', () => {
    const convId = 'conv-repair-cancel';
    const state = makeState(convId);
    state.messages = [asstToolCall('a1', ['call_1'])];

    const synthesized = repairDanglingToolCalls(state, 'Tool execution cancelled by user before it finished.');

    expect(synthesized).toHaveLength(1);
    expect(synthesized[0].content).toBe('Tool execution cancelled by user before it finished.');
  });

  it('does not repair tool calls intentionally parked by debugger or approval state', () => {
    const debugState = makeState('conv-repair-debug-pause');
    debugState.messages = [asstToolCall('a1', ['call_1'])];
    debugState.status = 'paused_debug';
    debugState.debugPendingAction = { action: 'TOOL_CALL', phase: 'after-model' };

    expect(repairDanglingToolCalls(debugState)).toEqual([]);
    expect(debugState.messages).toHaveLength(1);

    const approvalState = makeState('conv-repair-approval-pause');
    const pending = asstToolCall('a2', ['call_2']).tool_calls!;
    approvalState.messages = [asstToolCall('a2', ['call_2'])];
    approvalState.status = 'awaiting_tool_approval';
    approvalState.pendingToolCalls = pending;

    expect(repairDanglingToolCalls(approvalState)).toEqual([]);
    expect(approvalState.messages).toHaveLength(1);
  });

  it('folds synthesized results into the projection via appendRawForState', async () => {
    const convId = 'conv-repair-projection';
    const state = makeState(convId);
    FlowExecutor.conversationStates.set(convId, state);
    state.messages = [msg('u1', 'user'), asstToolCall('a1', ['call_1'])];

    const synthesized = repairDanglingToolCalls(state);
    await appendRawForState(state, synthesized.map((m) => ({ type: 'message', message: m })));
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    const projected = projectMessages(events!);
    const toolMsg = projected.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).tool_call_id).toBe('call_1');
    expect(toolMsg!.content).toBe(INTERRUPTED_TOOL_RESULT_CONTENT);
  });
});
