import { EventEmitter } from 'events';
import { ExecutionEvent, RawExecutionEvent, EmitFn } from '@/shared/types/execution/events';
import { appendFromBus } from '@/backend/execution/flow/conversationLog';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/engine/ExecutionEventBus');

// How many recent events to retain per conversation for replay on (re)connect.
const RING_BUFFER_SIZE = 1000;

// How many recent events to retain on the GLOBAL firehose for replay on
// (re)connect. Larger than the per-conversation buffer because it spans every
// conversation at once — sized for a few seconds of heavy subflow fan-out.
const GLOBAL_RING_BUFFER_SIZE = 5000;

// How long a channel (and its buffered events) survives after a run:done with
// no listeners. Long enough for the frontend's terminal refetch and any late
// replays; without this the channels Map grew for the process lifetime — one
// buffer of up to RING_BUFFER_SIZE message payloads per conversation ever run.
const CHANNEL_TTL_AFTER_DONE_MS = 5 * 60 * 1000;

interface ConversationChannel {
  emitter: EventEmitter;
  seq: number;
  buffer: ExecutionEvent[];
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

/**
 * In-memory pub/sub for execution events, keyed by conversationId.
 *
 * Mirrors the existing in-memory model of FlowExecutor.conversationStates: a
 * single Node process holds the live channels. Each event gets a monotonic
 * `seq` so SSE subscribers can replay from a known position (?fromSeq=) after
 * a reconnect without missing or duplicating events. The persisted SharedState
 * remains the source of truth, so a process restart that drops the buffer is
 * recoverable via a full GET of the conversation.
 */
class ExecutionEventBus {
  private channels = new Map<string, ConversationChannel>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // --- Global firehose (additive) ------------------------------------------
  // A single process-wide channel mirroring EVERY per-conversation event, so a
  // client (e.g. the brain viz) can watch all activity over ONE connection
  // instead of one EventSource per conversation — which hits the browser's
  // ~6-per-origin connection cap under heavy subflow fan-out. Purely additive:
  // the per-conversation channels are untouched, so chat streaming is
  // unaffected. Never garbage-collected: it spans the process lifetime.
  private globalEmitter = (() => {
    const e = new EventEmitter();
    e.setMaxListeners(0); // arbitrarily many firehose subscribers
    return e;
  })();
  private globalSeq = 0;
  private globalBuffer: GlobalEvent[] = [];

  private getChannel(conversationId: string): ConversationChannel {
    let channel = this.channels.get(conversationId);
    if (!channel) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0); // allow arbitrarily many SSE subscribers
      channel = { emitter, seq: 0, buffer: [] };
      this.channels.set(conversationId, channel);
    }
    return channel;
  }

  private cancelCleanup(conversationId: string): void {
    const timer = this.cleanupTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(conversationId);
    }
  }

  /** Drop the channel after the TTL unless the run resumed or someone is still
   *  listening. Deleting resets seq to 0 on recreation — safe, because clients
   *  subscribe fresh (fromSeq 0/absent) and the stale-'running' heuristic in the
   *  conversations list only applies to states persisted as 'running'. */
  private scheduleCleanup(conversationId: string, seqAtDone: number): void {
    this.cancelCleanup(conversationId);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(conversationId);
      const channel = this.channels.get(conversationId);
      if (!channel) return;
      if (channel.seq !== seqAtDone) return; // a new run emitted since; keep
      if (channel.emitter.listenerCount('event') > 0) return; // active SSE subscriber
      this.channels.delete(conversationId);
    }, CHANNEL_TTL_AFTER_DONE_MS);
    // Never keep the process alive just for channel GC.
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimers.set(conversationId, timer);
  }

  /** Publish an event; the bus stamps conversationId, seq and timestamp. */
  emit(conversationId: string, raw: RawExecutionEvent): ExecutionEvent {
    const channel = this.getChannel(conversationId);
    const event = {
      ...raw,
      conversationId,
      seq: channel.seq++,
      timestamp: Date.now(),
    } as ExecutionEvent;

    channel.buffer.push(event);
    if (channel.buffer.length > RING_BUFFER_SIZE) {
      channel.buffer.shift();
    }
    channel.emitter.emit('event', event);

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
    if (event.type === 'run:done') {
      this.scheduleCleanup(conversationId, channel.seq);
    } else {
      this.cancelCleanup(conversationId);
    }
    return event;
  }

  /** An emit function bound to a conversation, suitable to hand to the engine. */
  emitterFor(conversationId: string): EmitFn {
    return (raw) => {
      try {
        this.emit(conversationId, raw);
      } catch (err) {
        log.warn(`Failed to emit execution event for ${conversationId}`, { err });
      }
    };
  }

  /** Buffered events with seq >= fromSeq, for replay on (re)connect. */
  getBufferedSince(conversationId: string, fromSeq: number): ExecutionEvent[] {
    const channel = this.channels.get(conversationId);
    if (!channel) return [];
    return channel.buffer.filter((e) => e.seq >= fromSeq);
  }

  /** The next seq the channel will assign (i.e. current high-water mark). */
  currentSeq(conversationId: string): number {
    return this.channels.get(conversationId)?.seq ?? 0;
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(conversationId: string, listener: (event: ExecutionEvent) => void): () => void {
    const channel = this.getChannel(conversationId);
    channel.emitter.on('event', listener);
    return () => {
      channel.emitter.off('event', listener);
    };
  }

  // --- Global firehose API -------------------------------------------------

  /** Publish an event onto the global channel, assigning a monotonic globalSeq
   *  and retaining it in the global ring buffer for replay. */
  private publishGlobal(event: ExecutionEvent): void {
    const wrapped: GlobalEvent = { globalSeq: this.globalSeq++, event };
    this.globalBuffer.push(wrapped);
    if (this.globalBuffer.length > GLOBAL_RING_BUFFER_SIZE) this.globalBuffer.shift();
    this.globalEmitter.emit('event', wrapped);
  }

  /** Subscribe to the firehose (all conversations). Returns an unsubscribe fn. */
  subscribeGlobal(listener: (e: GlobalEvent) => void): () => void {
    this.globalEmitter.on('event', listener);
    return () => {
      this.globalEmitter.off('event', listener);
    };
  }

  /** Buffered firehose entries with globalSeq >= fromSeq, for replay on
   *  (re)connect. */
  getGlobalBufferedSince(fromSeq: number): GlobalEvent[] {
    return this.globalBuffer.filter((e) => e.globalSeq >= fromSeq);
  }

  /** The next globalSeq the firehose will assign (current high-water mark). */
  currentGlobalSeq(): number {
    return this.globalSeq;
  }
}

// Singleton across the process (and across Next.js hot-reloads in dev).
const globalForBus = globalThis as unknown as { __flujoExecutionEventBus?: ExecutionEventBus };
export const executionEventBus =
  globalForBus.__flujoExecutionEventBus ?? (globalForBus.__flujoExecutionEventBus = new ExecutionEventBus());
