import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { ExecutionEvent, RawExecutionEvent, EmitFn } from '@/shared/types/execution/events';
import { appendFromBus, allocateSeq } from '@/backend/execution/flow/conversationLog';
import { createLogger } from '@/utils/logger';
import { bindToCurrentWorkspace, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { MAX_EXECUTION_EVENT_WIRE_BYTES, snapshotEventPayload, type EventPayload } from './eventPayload';

const log = createLogger('backend/execution/flow/engine/ExecutionEventBus');
export const EVENT_REPLAY_LIMITS = Object.freeze({
  maxEventWireBytes: MAX_EXECUTION_EVENT_WIRE_BYTES,
  maxConversationEvents: 1000, maxWorkspaceEvents: 5000,
  maxConversationBytes: 4 * 1024 * 1024, maxWorkspaceBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024, maxChannels: 1024, maxWorkspaces: 64,
  channelTtlMs: 5 * 60 * 1000,
});
type ReplayLimits = { [K in keyof typeof EVENT_REPLAY_LIMITS]: number };
interface ReplayEntry { seq: number; payload: EventPayload }
interface ReplayChannel { emitter: EventEmitter; seq: number; buffer: ReplayEntry[]; bytes: number; unavailableThrough: number }
interface ConversationChannel extends ReplayChannel { terminalSeq?: number }
interface WorkspaceFirehose extends ReplayChannel { epoch: string }
/** Live delivery retains the original event only during synchronous publication. */
export interface GlobalEvent { globalSeq: number; event: ExecutionEvent; payload?: EventPayload }
export interface ReplayWindow { firstSeq: number; nextSeq: number; epoch?: string }

/** Bounded disposable projections. Canonical log/state and execution ownership are untouched. */
export class ExecutionEventBus {
  private channels = new Map<string, ConversationChannel>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private firehoses = new Map<string, WorkspaceFirehose>();
  // Conservative: count both channel/firehose references even when their JSON is shared.
  private retained = new Map<ReplayEntry, ReplayChannel>();
  private retainedBytes = 0;
  private droppedOversized = 0;
  private evictedEntries = 0;
  private omittedChannels = 0;
  private limits: ReplayLimits;

  constructor(limits: Partial<ReplayLimits> = {}) {
    this.limits = { ...EVENT_REPLAY_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid event replay limit');
    }
  }

  private removeEntry(entry: ReplayEntry, owner: ReplayChannel): void {
    if (!this.retained.delete(entry)) return;
    owner.bytes -= entry.payload.retainedBytes;
    this.retainedBytes -= entry.payload.retainedBytes;
    const index = owner.buffer.indexOf(entry);
    if (index !== -1) owner.buffer.splice(index, 1);
    this.evictedEntries++;
  }

  private clearBuffer(owner: ReplayChannel): void {
    for (const entry of [...owner.buffer]) this.removeEntry(entry, owner);
  }

  private retain(owner: ReplayChannel, seq: number, payload: EventPayload, maxBytes: number, maxEvents: number): void {
    if (payload.retainedBytes > maxBytes || payload.retainedBytes > this.limits.maxTotalBytes) { owner.unavailableThrough = seq + 1; return; }
    const entry = { seq, payload };
    owner.buffer.push(entry);
    owner.bytes += payload.retainedBytes;
    this.retainedBytes += payload.retainedBytes;
    this.retained.set(entry, owner);
    while (owner.bytes > maxBytes || owner.buffer.length > maxEvents) this.removeEntry(owner.buffer[0], owner);
    while (this.retainedBytes > this.limits.maxTotalBytes) {
      const oldest = this.retained.entries().next().value;
      if (!oldest) break;
      this.removeEntry(...oldest);
    }
  }

  private emitter(): EventEmitter { const emitter = new EventEmitter(); emitter.setMaxListeners(0); return emitter; }

  private cancelCleanup(key: string): void {
    const timer = this.cleanupTimers.get(key);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(key);
  }

  private removeChannel(key: string, channel: ConversationChannel): void {
    this.cancelCleanup(key);
    this.clearBuffer(channel);
    this.channels.delete(key);
  }

  private getChannel(conversationId: string): ConversationChannel | undefined {
    const key = workspaceCacheKey(conversationId);
    let channel = this.channels.get(key);
    if (!channel) {
      if (this.channels.size >= this.limits.maxChannels) {
        const unused = [...this.channels].find(([, value]) => value.emitter.listenerCount('event') === 0);
        if (unused) this.removeChannel(...unused);
        else { this.omittedChannels++; return undefined; }
      }
      channel = { emitter: this.emitter(), seq: 0, buffer: [], bytes: 0, unavailableThrough: 0 };
    }
    this.channels.delete(key);
    this.channels.set(key, channel);
    return channel;
  }

  private getFirehose(): WorkspaceFirehose | undefined {
    const workspace = getCurrentWorkspace();
    let firehose = this.firehoses.get(workspace);
    if (!firehose) {
      if (this.firehoses.size >= this.limits.maxWorkspaces) {
        const unused = [...this.firehoses].find(([, value]) => value.emitter.listenerCount('event') === 0);
        if (unused) { this.clearBuffer(unused[1]); this.firehoses.delete(unused[0]); }
        else { this.omittedChannels++; return undefined; }
      }
      firehose = { emitter: this.emitter(), seq: 0, buffer: [], bytes: 0, unavailableThrough: 0, epoch: randomUUID() };
    }
    this.firehoses.delete(workspace);
    this.firehoses.set(workspace, firehose);
    return firehose;
  }

  private scheduleCleanup(conversationId: string, channel: ConversationChannel): void {
    const key = workspaceCacheKey(conversationId);
    this.cancelCleanup(key);
    const seqAtDone = channel.terminalSeq;
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(key);
      if (this.channels.get(key) !== channel || channel.seq !== seqAtDone || channel.emitter.listenerCount('event')) return;
      this.removeChannel(key, channel);
    }, this.limits.channelTtlMs);
    timer.unref?.();
    this.cleanupTimers.set(key, timer);
  }

  emit(conversationId: string, raw: RawExecutionEvent): ExecutionEvent {
    const seq = allocateSeq(conversationId);
    const event = { ...raw, conversationId, seq, timestamp: Date.now() } as ExecutionEvent;
    const payload = snapshotEventPayload(event, this.limits.maxEventWireBytes);
    if (!payload) this.droppedOversized++;
    // Always preserve durable event semantics, including every dispatch marker.
    appendFromBus(event);
    const channel = this.getChannel(conversationId);
    if (channel) {
      channel.seq = seq + 1;
      if (payload) this.retain(channel, seq, payload, this.limits.maxConversationBytes, this.limits.maxConversationEvents);
      else channel.unavailableThrough = seq + 1;
      if (event.type === 'run:done') { channel.terminalSeq = channel.seq; this.scheduleCleanup(conversationId, channel); }
      else { channel.terminalSeq = undefined; this.cancelCleanup(workspaceCacheKey(conversationId)); }
      channel.emitter.emit('event', event, payload);
    }
    const firehose = this.getFirehose();
    if (firehose) {
      const globalSeq = firehose.seq++;
      if (payload) this.retain(firehose, globalSeq, payload, this.limits.maxWorkspaceBytes, this.limits.maxWorkspaceEvents);
      else firehose.unavailableThrough = globalSeq + 1;
      firehose.emitter.emit('event', { globalSeq, event, payload } satisfies GlobalEvent);
    }
    return event;
  }

  emitterFor(conversationId: string): EmitFn {
    return bindToCurrentWorkspace((raw: RawExecutionEvent) => { try { this.emit(conversationId, raw); } catch (err) { log.warn(`Failed to emit execution event for ${conversationId}`, { err }); } });
  }

  getBufferedSince(conversationId: string, fromSeq: number): ExecutionEvent[] {
    return this.channels.get(workspaceCacheKey(conversationId))?.buffer.filter(entry => entry.seq >= fromSeq).map(entry => JSON.parse(entry.payload.json) as ExecutionEvent) ?? [];
  }
  currentSeq(conversationId: string): number { return this.channels.get(workspaceCacheKey(conversationId))?.seq ?? 0; }
  replayWindow(conversationId: string): ReplayWindow {
    const channel = this.channels.get(workspaceCacheKey(conversationId));
    return { firstSeq: Math.max(channel?.buffer[0]?.seq ?? channel?.seq ?? 0, channel?.unavailableThrough ?? 0), nextSeq: channel?.seq ?? 0 };
  }
  subscribe(conversationId: string, listener: (event: ExecutionEvent, payload?: EventPayload) => void): () => void {
    const channel = this.getChannel(conversationId);
    if (!channel) throw new Error('Execution event channel capacity exhausted');
    channel.emitter.on('event', listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      channel.emitter.off('event', listener);
      if (!channel.emitter.listenerCount('event') && channel.terminalSeq !== undefined) this.scheduleCleanup(conversationId, channel);
    };
  }
  subscribeGlobal(listener: (event: GlobalEvent) => void): () => void {
    const firehose = this.getFirehose();
    if (!firehose) throw new Error('Execution firehose capacity exhausted');
    firehose.emitter.on('event', listener);
    return () => firehose.emitter.off('event', listener);
  }
  getGlobalBufferedSince(fromSeq: number): GlobalEvent[] {
    return this.getFirehose()?.buffer.filter(entry => entry.seq >= fromSeq).map(entry => ({ globalSeq: entry.seq, event: JSON.parse(entry.payload.json) as ExecutionEvent, payload: entry.payload })) ?? [];
  }
  currentGlobalSeq(): number { return this.getFirehose()?.seq ?? 0; }
  globalReplayWindow(): ReplayWindow {
    const firehose = this.getFirehose();
    return { firstSeq: Math.max(firehose?.buffer[0]?.seq ?? firehose?.seq ?? 0, firehose?.unavailableThrough ?? 0), nextSeq: firehose?.seq ?? 0, epoch: firehose?.epoch };
  }
  diagnostics() {
    return { retainedBytes: this.retainedBytes, retainedEntries: this.retained.size, channels: this.channels.size, workspaces: this.firehoses.size, droppedOversized: this.droppedOversized, evictedEntries: this.evictedEntries, omittedChannels: this.omittedChannels, limits: { ...this.limits } };
  }
}

const globalForBus = globalThis as unknown as { __flujoExecutionEventBus?: ExecutionEventBus };
export const executionEventBus = globalForBus.__flujoExecutionEventBus ?? (globalForBus.__flujoExecutionEventBus = new ExecutionEventBus());
