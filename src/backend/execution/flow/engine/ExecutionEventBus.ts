import { EventEmitter } from 'events';
import { ExecutionEvent, RawExecutionEvent, EmitFn } from '@/shared/types/execution/events';
import { appendFromBus } from '@/backend/execution/flow/conversationLog';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/engine/ExecutionEventBus');

// How many recent events to retain per conversation for replay on (re)connect.
const RING_BUFFER_SIZE = 1000;

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
}

// Singleton across the process (and across Next.js hot-reloads in dev).
const globalForBus = globalThis as unknown as { __flujoExecutionEventBus?: ExecutionEventBus };
export const executionEventBus =
  globalForBus.__flujoExecutionEventBus ?? (globalForBus.__flujoExecutionEventBus = new ExecutionEventBus());
