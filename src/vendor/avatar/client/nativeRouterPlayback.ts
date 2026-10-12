import { QwenPlayback, QWEN_MAX_QUEUED_SAMPLES, QWEN_MAX_RESPONSE_SAMPLES } from './qwenPlayback';
import type { QwenPlaybackTimer } from './qwenPlayback';

/** This rate is the reviewed Chat PCM packaging assumption, not a provider guarantee. */
export const NATIVE_ROUTER_RATE = 24_000;
export const NATIVE_ROUTER_RATE_QUALIFICATION = 'assumed' as const;
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_CHARS = 2 * 1024 * 1024;
const FRAME_SAMPLES = NATIVE_ROUTER_RATE; // Small frames let the reader apply backpressure.
export const nativeIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

export type NativeTurnEvent =
  | { type: 'start'; turnId: string; sampleRate: 24000; sampleRateQualification: 'assumed' }
  | { type: 'audio'; turnId: string; data: string }
  | { type: 'caption'; turnId: string; text: string }
  | { type: 'complete'; turnId: string; text: string; samples: number; usage: Record<string, unknown> }
  | { type: 'error'; turnId: string; code: string; error?: string };
export interface NativePlayed { turnId: string; playedSamples: number; complete: boolean; }
const invalid = (): never => { throw new Error('invalid_native_stream'); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function nativeAudioBytes(data: string): Uint8Array {
  if (typeof data !== 'string' || !data.length || data.length > MAX_EVENT_CHARS || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return invalid();
  let binary: string;
  try { binary = atob(data); } catch { return invalid(); }
  if (btoa(binary) !== data) return invalid();
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** A complete event is required; network EOF never implies a successful response. */
export class NativeTurnProtocol {
  turnId?: string;
  private terminal = false;
  private bytes = 0;
  private caption = '';
  accept(value: unknown): NativeTurnEvent {
    if (!record(value) || this.terminal || !nativeIdentifier(value.turnId)) return invalid();
    const keys: Record<string, string[]> = {
      start: ['type', 'turnId', 'sampleRate', 'sampleRateQualification'],
      audio: ['type', 'turnId', 'data'], caption: ['type', 'turnId', 'text'],
      complete: ['type', 'turnId', 'text', 'samples', 'usage'], error: ['type', 'turnId', 'code', 'error'],
    };
    const allowed = typeof value.type === 'string' ? keys[value.type] : undefined;
    if (!allowed || Object.keys(value).some(key => !allowed.includes(key))) return invalid();
    if (value.type === 'start') {
      if (this.turnId || value.sampleRate !== NATIVE_ROUTER_RATE || value.sampleRateQualification !== NATIVE_ROUTER_RATE_QUALIFICATION) return invalid();
      this.turnId = value.turnId;
    } else {
      if (!this.turnId || value.turnId !== this.turnId) return invalid();
      if (value.type === 'audio') {
        if (typeof value.data !== 'string') return invalid();
        this.bytes += nativeAudioBytes(value.data).length;
        if (this.bytes > QWEN_MAX_RESPONSE_SAMPLES * 2) return invalid();
      } else if (value.type === 'caption' || value.type === 'complete') {
        if (typeof value.text !== 'string' || value.text.length > 8000 || !value.text.startsWith(this.caption)) return invalid();
        this.caption = value.text;
        if (value.type === 'complete') {
          if (!Number.isInteger(value.samples) || Number(value.samples) <= 0 || Number(value.samples) !== this.bytes / 2 ||
            !record(value.usage) || JSON.stringify(value.usage).length > 4096) return invalid();
          this.terminal = true;
        }
      } else if (value.type === 'error') {
        if (typeof value.code !== 'string' || !/^[a-z_]{1,80}$/.test(value.code) ||
          value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 500)) return invalid();
        this.terminal = true;
      }
    }
    return value as unknown as NativeTurnEvent;
  }
  finish() { if (!this.terminal) invalid(); }
}

function aborted(): DOMException { return new DOMException('The native turn was cancelled.', 'AbortError'); }
export function nativeAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(aborted()); }
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Async handlers are awaited: fast native generation cannot bypass playback backpressure. */
export async function readNativeTurn(response: Response, signal: AbortSignal, event: (event: NativeTurnEvent) => Promise<void> | void): Promise<void> {
  if (!response.body || !/^application\/(?:x-)?ndjson(?:;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const reader = response.body!.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const protocol = new NativeTurnProtocol(); let pending = '', size = 0, ended = false;
  const line = async (text: string) => {
    if (signal.aborted) throw aborted();
    if (!text.trim()) return;
    if (text.length > MAX_EVENT_CHARS) invalid();
    await event(protocol.accept(JSON.parse(text)));
    if (signal.aborted) throw aborted();
  };
  try {
    while (true) {
      const result = await nativeAbortable(reader.read(), signal);
      if (result.done) { ended = true; break; }
      size += result.value.byteLength; if (size > MAX_WIRE_BYTES) invalid();
      pending += decoder.decode(result.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) { const next = pending.slice(0, newline); pending = pending.slice(newline + 1); await line(next); }
      if (pending.length > MAX_EVENT_CHARS) invalid();
    }
    pending += decoder.decode(); if (pending.trim()) await line(pending);
    protocol.finish();
  } finally {
    if (!ended) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([reader.cancel().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 100); })]); }
      finally { clearTimeout(timer); }
    }
    try { reader.releaseLock(); } catch { /* A transport can still be rejecting a pending read. */ }
  }
}

interface PlaybackOptions {
  onPlayed: (receipt: NativePlayed) => void;
  onError?: () => void;
  createContext?: () => AudioContext;
  timer?: QwenPlaybackTimer;
}
interface PlayedTurn { controller: AbortController; sealed: boolean; cancelled: boolean; receiptEmitted: boolean; carry?: number; received: number; writer: boolean; }
const defaultTimer: QwenPlaybackTimer = {
  now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Uses only Qwen's tested output ledger; its vendor-specific ACK never leaves this adapter. */
export class NativeRouterPlayback {
  readonly player: QwenPlayback;
  private readonly timer: QwenPlaybackTimer;
  private readonly turns = new Map<string, PlayedTurn>();
  private closed = false;
  constructor(private readonly options: PlaybackOptions) {
    this.timer = options.timer ?? defaultTimer;
    this.player = new QwenPlayback({ createContext: options.createContext, timer: this.timer,
      onError: () => { this.invalidate(); options.onError?.(); },
      onAck: ack => {
        const turn = this.turns.get(ack.response_id), cursor = this.player.cursor(ack.response_id);
        if (this.closed || !turn || !cursor || turn.receiptEmitted) return;
        const complete = turn.sealed && !turn.cancelled && cursor.done && cursor.receivedSamples > 0 && cursor.receivedSamples === cursor.playedSamples;
        // The app's false receipt means cancellation, never ordinary playback progress.
        if (!turn.cancelled && !complete) return;
        turn.receiptEmitted = true;
        options.onPlayed({ turnId: ack.response_id, playedSamples: cursor.playedSamples, complete });
      },
    });
  }
  get context() { return this.player.context; }
  get analyser() { return this.player.analyser; }
  get queuedSamples() { return this.player.queuedSamples; }
  get isClosed() { return this.closed || this.player.isClosed; }
  resume() { return this.player.resume(); }
  begin(turnId: string): boolean {
    if (this.closed || this.turns.has(turnId) || !nativeIdentifier(turnId) || !this.player.begin(turnId)) return false;
    this.turns.set(turnId, { controller: new AbortController(), sealed: false, cancelled: false, receiptEmitted: false, received: 0, writer: false }); return true;
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.isClosed) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {

      const cancel = () => { this.timer.cancel(handle); signal.removeEventListener('abort', cancel); reject(aborted()); };
      const handle = this.timer.schedule(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async enqueue(turnId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.sealed || turn.cancelled || turn.writer || this.isClosed || !(bytes instanceof Uint8Array) || !bytes.length) throw aborted();
    const combined = AbortSignal.any([signal, turn.controller.signal]);
    if (combined.aborted) throw aborted();
    if (turn.received + bytes.length > QWEN_MAX_RESPONSE_SAMPLES * 2) invalid();
    turn.writer = true;
    try {
      const joined = new Uint8Array(bytes.length + (turn.carry === undefined ? 0 : 1));
      if (turn.carry !== undefined) joined[0] = turn.carry;
      joined.set(bytes, turn.carry === undefined ? 0 : 1);
      turn.received += bytes.length;
      turn.carry = joined.length % 2 ? joined[joined.length - 1] : undefined;
      const even = joined.length - joined.length % 2;
      for (let offset = 0; offset < even;) {
        const count = Math.min(FRAME_SAMPLES * 2, even - offset);
        while (true) {
          if (combined.aborted || this.isClosed) throw aborted();
          this.player.cursor(turnId); // Refresh the hardware cursor before judging queue room.
          if (this.isClosed) throw aborted();
          if (this.player.queuedSamples + count / 2 <= QWEN_MAX_QUEUED_SAMPLES && this.player.pendingSegments < 512) break;
          await this.wait(20, combined);
        }
        if (combined.aborted || !this.player.enqueue(turnId, joined.subarray(offset, offset + count))) throw aborted();
        offset += count;
      }
    } finally { turn.writer = false; }
  }
  async drain(turnId: string, expectedSamples: number, signal: AbortSignal): Promise<void> {
    const turn = this.turns.get(turnId), cursor = this.player.cursor(turnId);
    if (!turn || turn.cancelled || turn.writer || turn.carry !== undefined || !cursor || !Number.isInteger(expectedSamples) ||
      expectedSamples <= 0 || expectedSamples !== cursor.receivedSamples || expectedSamples * 2 !== turn.received) return invalid();
    const combined = AbortSignal.any([signal, turn.controller.signal]);
    if (combined.aborted || this.isClosed) throw aborted();
    turn.sealed = true;
    if (!this.player.done(turnId)) throw aborted();
    while (true) {
      if (combined.aborted || this.isClosed) throw aborted();
      const played = this.player.cursor(turnId);
      if (played?.playedSamples === expectedSamples) return;
      await this.wait(20, combined);
    }
  }
  cancel(turnId: string): void {
    const turn = this.turns.get(turnId); if (!turn || turn.cancelled || this.closed) return;
    turn.cancelled = true; turn.carry = undefined; turn.controller.abort(); this.player.clear(turnId);
  }
  private invalidate() { this.closed = true; for (const turn of this.turns.values()) turn.controller.abort(); }
  close(): Promise<void> { this.invalidate(); this.turns.clear(); return this.player.close(); }
}
