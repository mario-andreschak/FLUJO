import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { ExecutionEvent, RawExecutionEvent, EmitFn } from '@/shared/types/execution/events';
import { appendFromBus, allocateSeq } from '@/backend/execution/flow/conversationLog';
import { createLogger } from '@/utils/logger';
import { bindToCurrentWorkspace, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { boundedEventSnapshot, type EventSnapshot } from './boundedEventSnapshot';

const log = createLogger('backend/execution/flow/engine/ExecutionEventBus');

// How many recent events to retain per conversation for replay on (re)connect.
const RING_BUFFER_SIZE = 1000;

// How many recent events to retain on the GLOBAL firehose for replay on
// (re)connect. Larger than the per-conversation buffer because it spans every
// conversation at once — sized for a few seconds of heavy subflow fan-out.
const GLOBAL_RING_BUFFER_SIZE = 5000;

// Shared serialized-retention contract. Both stored JSON strings are charged;
// conversation and global projections cannot each consume a separate allowance.
export const EXECUTION_REPLAY_LIMITS = Object.freeze({
  maxWorkspaceUtf8Bytes: 4 * 1024 * 1024, maxProcessUtf8Bytes: 16 * 1024 * 1024,
});
const GLOBAL_REPLAY_WORKSPACE_UTF8_BYTES = EXECUTION_REPLAY_LIMITS.maxWorkspaceUtf8Bytes;
const GLOBAL_REPLAY_PROCESS_UTF8_BYTES = EXECUTION_REPLAY_LIMITS.maxProcessUtf8Bytes;

// How long a channel (and its buffered events) survives after a run:done with
// no listeners. Long enough for the frontend's terminal refetch and any late
// replays; without this the channels Map grew for the process lifetime — one
// buffer of up to RING_BUFFER_SIZE message payloads per conversation ever run.
const CHANNEL_TTL_AFTER_DONE_MS = 5 * 60 * 1000;

export const CONVERSATION_REPLAY_LIMITS = Object.freeze({
  maxConversationUtf8Bytes: 4 * 1024 * 1024,
  maxChannels: 1024, maxWorkspaces: 64,
});
interface BufferedConversationEvent extends EventSnapshot { seq: number }
export interface ReplayWindow { firstSeq: number; nextSeq: number; epoch?: string }

interface ConversationChannel {
  emitter: EventEmitter;
  seq: number;
  buffer: BufferedConversationEvent[];
  utf8Bytes: number;
  /** The terminal event still owns this high-water mark; any later emit revokes it. */
  terminalSeq?: number;
}

/**
 * A firehose entry: an already-stamped event plus its own global sequence
 * number (independent of any per-conversation seq) so a single
 * all-conversations subscriber can resume via ?fromSeq without tracking N
 * per-conversation seqs.
 */
export interface GlobalEvent {
  globalSeq: number;
  event: ExecutionEvent;
}

interface WorkspaceFirehose {
  emitter: EventEmitter;
  seq: number;
  buffer: BufferedGlobalEvent[];
  utf8Bytes: number;
  epoch: string;
}

interface BufferedGlobalEvent extends EventSnapshot {
  globalSeq: number;
}

type RetainedEvent = BufferedConversationEvent | BufferedGlobalEvent;
type ReplayOwner = { workspace: string } & (
  { kind: 'conversation'; channel: ConversationChannel } | { kind: 'global'; firehose: WorkspaceFirehose }
);
interface WorkspaceReplayLedger { utf8Bytes: number; entries: Map<RetainedEvent, ReplayOwner> }

/**
 * In-memory pub/sub for execution events, keyed by conversationId.
 *
 * Mirrors the existing in-memory model of FlowExecutor.conversationStates: a
 * single Node process holds the live channels. Each event's `seq` is allocated
 * by the conversation log (allocateSeq) — an authoritative, durable, never-reset
 * per-conversation monotonic counter (issue #261) — so SSE subscribers can
 * replay from a known position (?fromSeq=) after a reconnect, across runs,
 * channel garbage-collection, and process restarts, without missing or
 * duplicating events. `channel.seq` is kept only as an in-memory high-water
 * mirror for currentSeq()/cleanup.
 */
export class ExecutionEventBus {
  private channels = new Map<string, ConversationChannel>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // --- Global firehose (additive) ------------------------------------------
  // A single process-wide channel mirroring EVERY per-conversation event, so a
  // client (e.g. the brain viz) can watch all activity over ONE connection
  // instead of one EventSource per conversation — which hits the browser's
  // ~6-per-origin connection cap under heavy subflow fan-out. Inactive workspace
  // projections may be evicted at the metadata cap; versioned cursors bind to
  // an epoch so their clients can detect a newly-created projection.
  private firehoses = new Map<string, WorkspaceFirehose>();
  // Insertion order is publication order across workspaces. Removing a cache
  // entry also removes this reference; an empty workspace retains no payload.
  private globalReplayEntries = new Map<BufferedGlobalEvent, WorkspaceFirehose>();
  private globalReplayUtf8Bytes = 0;
  private conversationReplayEntries = new Map<BufferedConversationEvent, ConversationChannel>();
  private conversationReplayUtf8Bytes = 0;
  private replayEntries = new Map<RetainedEvent, ReplayOwner>();
  private replayWorkspaces = new Map<string, WorkspaceReplayLedger>();
  private replayUtf8Bytes = 0;

  private chargeReplay(entry: RetainedEvent, owner: ReplayOwner): void {
    // Evict before reserving a retained slot; serialization's temporary copy
    // is separate, but the shared reservation never exceeds either allowance.
    let workspace = this.replayWorkspaces.get(owner.workspace);
    while (workspace && workspace.utf8Bytes + entry.utf8Bytes > EXECUTION_REPLAY_LIMITS.maxWorkspaceUtf8Bytes) {
      const oldest = workspace.entries.values().next().value;
      if (!oldest) break;
      this.evictReplayOwner(oldest);
    }
    while (this.replayUtf8Bytes + entry.utf8Bytes > EXECUTION_REPLAY_LIMITS.maxProcessUtf8Bytes) {
      const oldest = this.replayEntries.values().next().value;
      if (!oldest) break;
      this.evictReplayOwner(oldest);
    }
    workspace = this.replayWorkspaces.get(owner.workspace);
    if (!workspace) {
      workspace = { utf8Bytes: 0, entries: new Map() };
      this.replayWorkspaces.set(owner.workspace, workspace);
    }
    workspace.entries.set(entry, owner);
    workspace.utf8Bytes += entry.utf8Bytes;
    this.replayEntries.set(entry, owner);
    this.replayUtf8Bytes += entry.utf8Bytes;
  }

  private releaseReplay(entry: RetainedEvent): void {
    const owner = this.replayEntries.get(entry);
    if (!owner) return;
    this.replayEntries.delete(entry);
    this.replayUtf8Bytes -= entry.utf8Bytes;
    const workspace = this.replayWorkspaces.get(owner.workspace);
    if (!workspace) return;
    workspace.entries.delete(entry);
    workspace.utf8Bytes -= entry.utf8Bytes;
    if (workspace.entries.size === 0) this.replayWorkspaces.delete(owner.workspace);
  }

  private evictReplayOwner(owner: ReplayOwner): void {
    if (owner.kind === 'conversation') this.evictConversationReplayPrefix(owner.channel);
    else this.evictGlobalReplayPrefix(owner.firehose);
  }

  private getFirehose(): WorkspaceFirehose | undefined {
    const workspace = getCurrentWorkspace();
    let firehose = this.firehoses.get(workspace);
    if (!firehose) {
      if (this.firehoses.size >= CONVERSATION_REPLAY_LIMITS.maxWorkspaces) {
        const unused = [...this.firehoses].find(([, entry]) => entry.emitter.listenerCount('event') === 0);
        if (!unused) return undefined;
        while (unused[1].buffer.length) this.evictGlobalReplayPrefix(unused[1]);
        this.firehoses.delete(unused[0]);
      }
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      firehose = { emitter, seq: 0, buffer: [], utf8Bytes: 0, epoch: randomUUID() };
      this.firehoses.set(workspace, firehose);
    }
    return firehose;
  }

  private getChannel(conversationId: string): ConversationChannel | undefined {
    const key = workspaceCacheKey(conversationId);
    let channel = this.channels.get(key);
    if (!channel) {
      if (this.channels.size >= CONVERSATION_REPLAY_LIMITS.maxChannels) {
        const unused = [...this.channels].find(([, entry]) => entry.emitter.listenerCount('event') === 0);
        if (!unused) return undefined;
        this.removeChannel(unused[0], unused[1]);
      }
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0); // allow arbitrarily many SSE subscribers
      // seq:0 is a placeholder; the first emit overwrites it with the durable
      // high-water mark (allocateSeq()+1), so a recreated channel never resets
      // the sequence a subscriber sees.
      channel = { emitter, seq: 0, buffer: [], utf8Bytes: 0 };
      this.channels.set(key, channel);
    }
    return channel;
  }

  private evictConversationReplayPrefix(channel: ConversationChannel): void {
    const oldest = channel.buffer.shift();
    if (!oldest) return;
    channel.utf8Bytes -= oldest.utf8Bytes;
    this.conversationReplayUtf8Bytes -= oldest.utf8Bytes;
    this.conversationReplayEntries.delete(oldest);
    this.releaseReplay(oldest);
    if (channel.buffer.length === 0) channel.buffer = [];
  }

  private removeChannel(key: string, channel: ConversationChannel): void {
    this.cancelCleanup(key);
    while (channel.buffer.length) this.evictConversationReplayPrefix(channel);
    this.channels.delete(key);
  }

  private retainConversationReplay(channel: ConversationChannel, event: ExecutionEvent): void {
    const snapshot = boundedEventSnapshot(event, CONVERSATION_REPLAY_LIMITS.maxConversationUtf8Bytes);
    if (!snapshot) {
      // Keep an available suffix; canonical persistence/live publication still get the original.
      while (channel.buffer.length) this.evictConversationReplayPrefix(channel);
      return;
    }
    const entry = { ...snapshot, seq: event.seq };
    this.chargeReplay(entry, { workspace: getCurrentWorkspace(), kind: 'conversation', channel });
    channel.buffer.push(entry);
    channel.utf8Bytes += entry.utf8Bytes;
    this.conversationReplayUtf8Bytes += entry.utf8Bytes;
    this.conversationReplayEntries.set(entry, channel);
    while (channel.buffer.length > RING_BUFFER_SIZE || channel.utf8Bytes > CONVERSATION_REPLAY_LIMITS.maxConversationUtf8Bytes) {
      this.evictConversationReplayPrefix(channel);
    }
  }

  ensureConversationProjection(conversationId: string): boolean { return this.getChannel(conversationId) !== undefined; }
  ensureGlobalProjection(): boolean { return this.getFirehose() !== undefined; }

  private cancelCleanup(key: string): void {
    const timer = this.cleanupTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(key);
    }
  }

  /** Drop the channel after the TTL unless the run resumed or someone is still
   *  listening. Safe even though the in-memory channel (and its ring buffer) is
   *  gone: seq is now allocated by the durable log counter (issue #261), so a
   *  recreated channel continues the monotonic sequence rather than resetting to
   *  0. SSE uses bounded JSONL replay or asks its reader to reload a snapshot. */
  private scheduleCleanup(key: string, expectedChannel: ConversationChannel, expectedSeq: number): void {
    this.cancelCleanup(key);
    const timer = setTimeout(() => {
      if (this.cleanupTimers.get(key) !== timer) return;
      this.cleanupTimers.delete(key);
      const channel = this.channels.get(key);
      if (channel !== expectedChannel || channel.seq !== expectedSeq) return;
      const empty = channel.seq === 0 && channel.buffer.length === 0;
      if (!empty && channel.terminalSeq !== expectedSeq) return;
      if (channel.emitter.listenerCount('event') > 0) return; // active SSE subscriber
      this.removeChannel(key, channel);
    }, CHANNEL_TTL_AFTER_DONE_MS);
    // Never keep the process alive just for channel GC.
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimers.set(key, timer);
  }

  /** Publish an event; the bus stamps conversationId, seq and timestamp. */
  emit(conversationId: string, raw: RawExecutionEvent): ExecutionEvent {
    const channel = this.getChannel(conversationId);
    const key = workspaceCacheKey(conversationId);
    // Authoritative, durable, per-conversation monotonic seq from the log.
    const seq = allocateSeq(conversationId);
    if (channel) {
      channel.seq = seq + 1; // durable high-water mirror; never grants execution authority
      this.cancelCleanup(key);
      channel.terminalSeq = raw.type === 'run:done' ? channel.seq : undefined;
    }
    const event = {
      ...raw,
      conversationId,
      seq,
      timestamp: Date.now(),
    } as ExecutionEvent;

    if (channel) {
      this.retainConversationReplay(channel, event);
      channel.emitter.emit('event', event);
    }

    // The live stream IS the conversation log being appended (execution-core
    // v2 §3.1): every emit — regardless of which emitter produced it (runFlow's
    // loop, ModelHandler's mid-run transcript sink, control routes) — is tapped
    // into the append-only per-conversation log. The tap filters transient
    // event types and enforces the ephemeral policy itself, and is
    // fire-and-forget so persistence can never break live consumers.
    appendFromBus(event);

    // Fan the same event onto the global firehose. The per-conversation channel
    // above already delivered it (chat is unaffected); this is an extra tap for
    // all-conversations subscribers.
    this.publishGlobal(event);

    // Terminal event → the channel becomes garbage once nobody replays it.
    // Any other event (e.g. run:start of a resumed conversation) revives it.
    if (channel && event.type === 'run:done' && channel.seq === seq + 1 && channel.terminalSeq === seq + 1) {
      // A synchronous listener can emit a resumed run. The old terminal event
      // must not schedule cleanup for that newer channel revision.
      this.scheduleCleanup(key, channel, seq + 1);
    }
    return event;
  }

  /** An emit function bound to a conversation, suitable to hand to the engine. */
  emitterFor(conversationId: string): EmitFn {
    return bindToCurrentWorkspace((raw: RawExecutionEvent) => {
      try {
        this.emit(conversationId, raw);
      } catch (err) {
        log.warn(`Failed to emit execution event for ${conversationId}`, { err });
      }
    });
  }

  /** Buffered events with seq >= fromSeq, for replay on (re)connect. */
  getBufferedSince(conversationId: string, fromSeq: number): ExecutionEvent[] {
    const channel = this.channels.get(workspaceCacheKey(conversationId));
    if (!channel) return [];
    return channel.buffer.filter((e) => e.seq >= fromSeq).map(e => JSON.parse(e.json) as ExecutionEvent);
  }

  replayWindow(conversationId: string): ReplayWindow {
    const channel = this.channels.get(workspaceCacheKey(conversationId));
    return { firstSeq: channel?.buffer[0]?.seq ?? channel?.seq ?? 0, nextSeq: channel?.seq ?? 0 };
  }

  /** The next seq the channel will assign (i.e. current high-water mark). */
  currentSeq(conversationId: string): number {
    return this.channels.get(workspaceCacheKey(conversationId))?.seq ?? 0;
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(conversationId: string, listener: (event: ExecutionEvent) => void): () => void {
    const channel = this.getChannel(conversationId);
    if (!channel) throw new Error('Execution event channel capacity exhausted');
    const key = workspaceCacheKey(conversationId);
    this.cancelCleanup(key);
    channel.emitter.on('event', listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      channel.emitter.off('event', listener);
      if (this.channels.get(key) !== channel || channel.emitter.listenerCount('event') > 0) return;
      // A subscriber may outlive the original terminal cleanup timer. Re-arm
      // when the final listener leaves; retain running, paused and unknown
      // channels. The captured key also keeps deferred cleanup workspace-bound.
      if (channel.terminalSeq === channel.seq || (channel.seq === 0 && channel.buffer.length === 0)) {
        this.scheduleCleanup(key, channel, channel.seq);
      }
    };
  }

  // --- Global firehose API -------------------------------------------------

  private evictGlobalReplayPrefix(firehose: WorkspaceFirehose): void {
    const oldest = firehose.buffer.shift();
    if (!oldest) return;
    firehose.utf8Bytes -= oldest.utf8Bytes;
    this.globalReplayUtf8Bytes -= oldest.utf8Bytes;
    this.globalReplayEntries.delete(oldest);
    this.releaseReplay(oldest);
    // Release the array's former backing storage too, without resetting the
    // workspace's live emitter or global sequence/reconnect high-water mark.
    if (firehose.buffer.length === 0) firehose.buffer = [];
  }

  private retainGlobalReplay(firehose: WorkspaceFirehose, wrapped: GlobalEvent): void {
    const snapshot = boundedEventSnapshot(wrapped, GLOBAL_REPLAY_WORKSPACE_UTF8_BYTES);
    if (!snapshot) {
      // A skipped entry must not leave a hole inside the cached suffix. The
      // global stream has always been best-effort recent replay, with no log
      // fallback. Live delivery below still publishes this exact event/id.
      while (firehose.buffer.length) this.evictGlobalReplayPrefix(firehose);
      return;
    }
    const entry: BufferedGlobalEvent = { ...snapshot, globalSeq: wrapped.globalSeq };
    this.chargeReplay(entry, { workspace: getCurrentWorkspace(), kind: 'global', firehose });
    firehose.buffer.push(entry);
    firehose.utf8Bytes += entry.utf8Bytes;
    this.globalReplayUtf8Bytes += entry.utf8Bytes;
    this.globalReplayEntries.set(entry, firehose);
    while (firehose.buffer.length > GLOBAL_RING_BUFFER_SIZE || firehose.utf8Bytes > GLOBAL_REPLAY_WORKSPACE_UTF8_BYTES) {
      this.evictGlobalReplayPrefix(firehose);
    }
  }

  /** Publish an event onto the global channel, assigning a monotonic globalSeq
   *  and retaining it in the global ring buffer for replay. */
  private publishGlobal(event: ExecutionEvent): void {
    const firehose = this.getFirehose();
    if (!firehose) return; // optional projection only; appendFromBus has already run
    const wrapped: GlobalEvent = { globalSeq: firehose.seq++, event };
    this.retainGlobalReplay(firehose, wrapped);
    firehose.emitter.emit('event', wrapped);
  }

  /** Subscribe to the firehose (all conversations). Returns an unsubscribe fn. */
  subscribeGlobal(listener: (e: GlobalEvent) => void): () => void {
    const firehose = this.getFirehose();
    if (!firehose) throw new Error('Execution firehose capacity exhausted');
    firehose.emitter.on('event', listener);
    return () => {
      firehose.emitter.off('event', listener);
    };
  }

  /** Detached JSON snapshots of the available recent suffix, with globalSeq
   *  >= fromSeq. Count/byte pressure or an uncacheable event can evict a prefix;
   *  unlike conversation replay, the global stream has no durable fallback. */
  getGlobalBufferedSince(fromSeq: number): GlobalEvent[] {
    return this.getFirehose()?.buffer
      .filter((entry) => entry.globalSeq >= fromSeq)
      .map((entry) => JSON.parse(entry.json) as GlobalEvent) ?? [];
  }

  /** Serialized replay-cache accounting, excluding object overhead/live/SSE. */
  getGlobalReplayPressure() {
    const workspace = this.firehoses.get(getCurrentWorkspace());
    let cachedWorkspaces = 0;
    for (const firehose of this.firehoses.values()) {
      if (firehose.buffer.length > 0) cachedWorkspaces++;
    }
    return {
      workspaceUtf8Bytes: workspace?.utf8Bytes ?? 0,
      processUtf8Bytes: this.globalReplayUtf8Bytes,
      cachedEvents: this.globalReplayEntries.size,
      cachedWorkspaces,
      maxWorkspaceUtf8Bytes: GLOBAL_REPLAY_WORKSPACE_UTF8_BYTES,
      maxProcessUtf8Bytes: GLOBAL_REPLAY_PROCESS_UTF8_BYTES,
    };
  }

  /** The next globalSeq the firehose will assign (current high-water mark). */
  currentGlobalSeq(): number {
    return this.getFirehose()?.seq ?? 0;
  }

  globalReplayWindow(): ReplayWindow {
    const firehose = this.getFirehose();
    return { firstSeq: firehose?.buffer[0]?.globalSeq ?? firehose?.seq ?? 0,
      nextSeq: firehose?.seq ?? 0, epoch: firehose?.epoch };
  }

  getConversationReplayPressure() {
    return { processUtf8Bytes: this.conversationReplayUtf8Bytes, cachedEvents: this.conversationReplayEntries.size,
      channels: this.channels.size, workspaces: this.firehoses.size, limits: { ...CONVERSATION_REPLAY_LIMITS } };
  }

  /** Actual stored serialized bytes across both caches, excluding heap/queues. */
  getReplayPressure() {
    return { workspaceUtf8Bytes: this.replayWorkspaces.get(getCurrentWorkspace())?.utf8Bytes ?? 0,
      processUtf8Bytes: this.replayUtf8Bytes, cachedEntries: this.replayEntries.size,
      cachedWorkspaces: this.replayWorkspaces.size, globalUtf8Bytes: this.globalReplayUtf8Bytes,
      conversationUtf8Bytes: this.conversationReplayUtf8Bytes, limits: { ...EXECUTION_REPLAY_LIMITS } };
  }
}

// Singleton across the process (and across Next.js hot-reloads in dev).
const globalForBus = globalThis as unknown as { __flujoExecutionEventBus?: ExecutionEventBus };
export const executionEventBus =
  globalForBus.__flujoExecutionEventBus ?? (globalForBus.__flujoExecutionEventBus = new ExecutionEventBus());
