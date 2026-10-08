import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  MeetingEmitFn,
  MeetingEvent,
  RawMeetingEvent,
} from '@/shared/types/meeting';
import { createLogger } from '@/utils/logger';
import {
  bindToCurrentWorkspace,
  workspaceCacheKey,
} from '@/utils/workspace';
import {
  appendMeetingEvent,
  appendMeetingEventBatch,
  latestMeetingSequence,
  MeetingEventAppendError,
  readMeetingEvents,
} from './eventLog';

const log = createLogger('backend/services/meetings/MeetingEventBus');
const DEFAULT_RING_BUFFER_SIZE = 1_000;

interface MeetingChannel {
  emitter: EventEmitter;
  /** Next sequence after the highest event observed by this bus instance. */
  seq: number;
  buffer: MeetingEvent[];
  /** Events already broadcast live by this process, including recovered writes. */
  publishedEventIds: Set<string>;
  /** Ambiguous new writes still needing proof and one live publication. */
  pendingPublicationIds: Set<string>;
}

/**
 * Durable per-meeting pub/sub.
 *
 * Unlike model token streaming, meeting events are sparse coordination facts.
 * `emit` therefore waits for the JSONL append before notifying subscribers:
 * anything visible over SSE is already safe to replay after a restart.
 */
export class MeetingEventBus {
  private readonly channels = new Map<string, MeetingChannel>();
  private readonly emitChains = new Map<string, Promise<unknown>>();

  constructor(private readonly ringBufferSize = DEFAULT_RING_BUFFER_SIZE) {
    if (!Number.isSafeInteger(ringBufferSize) || ringBufferSize < 1) {
      throw new Error('Meeting event ring buffer size must be a positive integer');
    }
  }

  private key(meetingId: string): string {
    return workspaceCacheKey('meeting-event-bus', meetingId);
  }

  private getChannel(meetingId: string): MeetingChannel {
    const key = this.key(meetingId);
    let channel = this.channels.get(key);
    if (!channel) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      channel = {
        emitter,
        seq: 0,
        buffer: [],
        publishedEventIds: new Set(),
        pendingPublicationIds: new Set(),
      };
      this.channels.set(key, channel);
    }
    return channel;
  }

  private enqueueEmit<T>(meetingId: string, task: () => Promise<T>): Promise<T> {
    const key = this.key(meetingId);
    const previous = this.emitChains.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => { /* one failed persistence attempt must not wedge the bus */ })
      .then(task);
    this.emitChains.set(key, run);
    void run.catch(() => { /* surfaced to emit's caller */ }).finally(() => {
      if (this.emitChains.get(key) === run) this.emitChains.delete(key);
    });
    return run;
  }

  private publish(meetingId: string, events: readonly MeetingEvent[]): void {
    if (events.length === 0) return;
    const channel = this.getChannel(meetingId);
    const ordered = [...events].sort((left, right) => left.seq - right.seq);
    for (const event of ordered) {
      if (channel.publishedEventIds.has(event.eventId)) continue;
      channel.publishedEventIds.add(event.eventId);
      channel.seq = Math.max(channel.seq, event.seq + 1);
      channel.buffer.push(event);
      channel.buffer.sort((left, right) => left.seq - right.seq);
      if (channel.buffer.length > this.ringBufferSize) channel.buffer.shift();
      channel.emitter.emit('event', event);
    }
  }

  private async publishDurableEventIds(
    meetingId: string,
    eventIds: ReadonlySet<string>,
  ): Promise<void> {
    try {
      const durable = (await readMeetingEvents(meetingId))
      .filter((event) => eventIds.has(event.eventId));
      this.publish(meetingId, durable);
      const channel = this.getChannel(meetingId);
      for (const event of durable) channel.pendingPublicationIds.delete(event.eventId);
    } catch (error) {
      // Preserve the original append error. A later idempotent retry will make
      // another reconciliation attempt and publish any durable record then.
      log.warn(`Failed to reconcile an ambiguous meeting append for ${meetingId}`, { error });
    }
  }

  /** Persist, buffer, then publish an event. */
  emit(meetingId: string, raw: RawMeetingEvent): Promise<MeetingEvent> {
    return this.enqueueEmit(meetingId, async () => {
      const normalized = raw.eventId ? raw : { ...raw, eventId: randomUUID() };
      try {
        const { event, appended } = await appendMeetingEvent(meetingId, normalized);
        // An idempotent retry may be the first point at which this process can
        // prove that an earlier, ambiguously failed append was durable.
        const channel = this.getChannel(meetingId);
        if (appended || channel.pendingPublicationIds.has(event.eventId)) {
          this.publish(meetingId, [event]);
          channel.pendingPublicationIds.delete(event.eventId);
        }
        return event;
      } catch (error) {
        if (error instanceof MeetingEventAppendError) {
          const channel = this.getChannel(meetingId);
          for (const eventId of error.eventIds) channel.pendingPublicationIds.add(eventId);
          await this.publishDurableEventIds(meetingId, new Set(error.eventIds));
        }
        throw error;
      }
    });
  }

  /** Persist one barrier batch atomically, then publish its new events in order. */
  emitBatch(
    meetingId: string,
    batchId: string,
    raws: readonly RawMeetingEvent[],
  ): Promise<MeetingEvent[]> {
    return this.enqueueEmit(meetingId, async () => {
      const normalized = raws.map((raw) =>
        raw.eventId ? raw : { ...raw, eventId: randomUUID() });
      try {
        const { events, appendedEvents } = await appendMeetingEventBatch(
          meetingId,
          batchId,
          normalized,
        );
        const channel = this.getChannel(meetingId);
        const publishable = [
          ...appendedEvents,
          ...events.filter((event) => channel.pendingPublicationIds.has(event.eventId)),
        ];
        this.publish(meetingId, publishable);
        for (const event of publishable) {
          channel.pendingPublicationIds.delete(event.eventId);
        }
        return events;
      } catch (error) {
        if (error instanceof MeetingEventAppendError) {
          const channel = this.getChannel(meetingId);
          for (const eventId of error.eventIds) channel.pendingPublicationIds.add(eventId);
          await this.publishDurableEventIds(meetingId, new Set(error.eventIds));
        }
        throw error;
      }
    });
  }

  /** Async emit function bound to both a meeting and the current workspace. */
  emitterFor(meetingId: string): MeetingEmitFn {
    return bindToCurrentWorkspace(async (raw: RawMeetingEvent) => {
      try {
        return await this.emit(meetingId, raw);
      } catch (error) {
        log.warn(`Failed to emit meeting event for ${meetingId}`, { error });
        throw error;
      }
    });
  }

  /** Events retained in memory with seq >= the inclusive resume cursor. */
  getBufferedSince(meetingId: string, fromSeq: number): MeetingEvent[] {
    const channel = this.channels.get(this.key(meetingId));
    if (!channel) return [];
    return channel.buffer.filter((event) => event.seq >= fromSeq);
  }

  /** Next sequence observed in this process (zero before this bus emits). */
  currentSeq(meetingId: string): number {
    return this.channels.get(this.key(meetingId))?.seq ?? 0;
  }

  /** Durable high-water mark, including events written before this process. */
  async latestSequence(meetingId: string): Promise<number> {
    return latestMeetingSequence(meetingId);
  }

  /**
   * Replay from memory when the cursor is covered, otherwise fall back to the
   * durable JSONL log (for process restarts or an evicted ring-buffer prefix).
   */
  async replaySince(meetingId: string, fromSeq: number): Promise<MeetingEvent[]> {
    const channel = this.channels.get(this.key(meetingId));
    if (channel && channel.buffer.length > 0 && fromSeq >= channel.buffer[0].seq) {
      return channel.buffer.filter((event) => event.seq >= fromSeq);
    }
    return readMeetingEvents(meetingId, { fromSeq });
  }

  /** Subscribe to live, already-durable events. Returns idempotent unsubscribe. */
  subscribe(meetingId: string, listener: (event: MeetingEvent) => void): () => void {
    const channel = this.getChannel(meetingId);
    const scopedListener = bindToCurrentWorkspace((event: MeetingEvent) => {
      try {
        listener(event);
      } catch (error) {
        log.warn(`Meeting event listener threw for ${meetingId}`, { error });
      }
    });
    channel.emitter.on('event', scopedListener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      channel.emitter.off('event', scopedListener);
    };
  }

  /** Test/diagnostic helper; does not touch durable logs. */
  clear(meetingId?: string): void {
    if (meetingId) {
      const key = this.key(meetingId);
      this.channels.delete(key);
      this.emitChains.delete(key);
      return;
    }
    this.channels.clear();
    this.emitChains.clear();
  }
}

declare global {
  var __flujoMeetingEventBus: MeetingEventBus | undefined;
}

export const meetingEventBus =
  globalThis.__flujoMeetingEventBus
  ?? (globalThis.__flujoMeetingEventBus = new MeetingEventBus());
