import { Pcm16Stream } from './audio';

export const QWEN_PLAYBACK_RATE = 24_000;
export const QWEN_MAX_CHUNK_SAMPLES = QWEN_PLAYBACK_RATE * 4;
export const QWEN_MAX_QUEUED_SAMPLES = QWEN_PLAYBACK_RATE * 5;
export const QWEN_MAX_RESPONSE_SAMPLES = QWEN_PLAYBACK_RATE * 31;
export const QWEN_MAX_RESPONSE_IDS = 128;
export const QWEN_MAX_PENDING_SEGMENTS = 512;
export const QWEN_OUTPUT_STALL_MS = 5_000;

/** Pinned vLLM-Omni 423 playback ACK. Milliseconds are quantized from played samples. */
export interface QwenPlaybackAck {
  type: 'playback.ack';
  response_id: string;
  item_id: string;
  played_ms: number;
  committed_ms: number;
}
export type QwenPlaybackError = 'invalid_response' | 'invalid_pcm' | 'response_not_started' |
  'audio_after_done' | 'playback_capacity' | 'output_clock' | 'output_stalled' | 'audio_device';
export interface QwenPlaybackTimer {
  now(): number;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
}
interface Options {
  onAck: (ack: QwenPlaybackAck) => void;
  onError?: (code: QwenPlaybackError) => void;
  createContext?: () => AudioContext;
  timer?: QwenPlaybackTimer;
}
interface Segment {
  start: number;
  samples: number;
  source?: AudioBufferSourceNode;
}
interface ResponsePlayback {
  readonly id: string;
  received: number;
  played: number;
  retired: number;
  segments: Segment[];
  done: boolean;
  acknowledged: boolean;
  cancelled: boolean;
}

const browserTimer: QwenPlaybackTimer = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const identifier = (value: string) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);

/**
 * Output-only, single-session PCM player. It never reads, clears or pauses input.
 * ACKs follow the WebAudio output timestamp, not received bytes or onended.
 * This is an output-clock estimate; actual acoustic cancellation needs browser QA.
 */
export class QwenPlayback {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  private readonly timer: QwenPlaybackTimer;
  private readonly responses = new Map<string, ResponsePlayback>();
  private poll?: unknown;
  private pollEpoch = 0;
  private closed = false;
  private closePromise?: Promise<void>;
  private outputTime = 0;
  private renderTime = 0;
  private scheduled = 0;
  private progressAt: number;
  private progressSamples = 0;

  constructor(private readonly options: Options) {
    this.timer = options.timer ?? browserTimer;
    this.progressAt = this.timer.now();
    this.context = (options.createContext ?? (() => new AudioContext({ sampleRate: QWEN_PLAYBACK_RATE })))();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.context.destination);
  }

  get isClosed() { return this.closed; }
  get queuedSamples() {
    let count = 0;
    for (const response of this.responses.values()) if (!response.cancelled) count += response.received - response.played;
    return count;
  }
  get pendingSegments() {
    let count = 0;
    for (const response of this.responses.values()) count += response.segments.length;
    return count;
  }
  isSuppressed(id: string) { return this.closed || this.responses.get(id)?.cancelled === true; }

  async resume(): Promise<boolean> {
    if (this.closed) return false;
    try { await this.context.resume(); }
    catch { this.fail('audio_device'); return false; }
    return !this.closed;
  }

  /** Called for response.created; IDs can never be reused, even after drain. */
  begin(id: string): boolean {
    if (this.closed) return false;
    if (!identifier(id)) return this.fail('invalid_response');
    if (this.responses.has(id)) return false;
    if (this.responses.size >= QWEN_MAX_RESPONSE_IDS) return this.fail('playback_capacity');
    this.responses.set(id, { id, received: 0, played: 0, retired: 0, segments: [], done: false, acknowledged: false, cancelled: false });
    return true;
  }

  /** A wire delta contains complete little-endian PCM16 samples at24k, without a WAV header. */
  enqueue(id: string, bytes: Uint8Array): boolean {
    if (this.closed || this.responses.get(id)?.cancelled) return false;
    const response = this.responses.get(id);
    if (!response) return this.fail('response_not_started');
    if (response.done) return this.fail('audio_after_done');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > QWEN_MAX_CHUNK_SAMPLES * 2) return this.fail('invalid_pcm');
    this.refresh();
    if (this.closed || response.cancelled) return false;
    const samples = bytes.length / 2;
    if (this.queuedSamples + samples > QWEN_MAX_QUEUED_SAMPLES || response.received + samples > QWEN_MAX_RESPONSE_SAMPLES ||
        this.pendingSegments >= QWEN_MAX_PENDING_SEGMENTS) return this.fail('playback_capacity');
    try {
      // decode() copies caller memory; AudioBuffer owns a second copy used by the device.
      const pcm = new Pcm16Stream().decode(bytes);
      const buffer = this.context.createBuffer(1, samples, QWEN_PLAYBACK_RATE);
      buffer.getChannelData(0).set(pcm);
      const source = this.context.createBufferSource();
      const start = Math.max(this.scheduled, this.context.currentTime + .025);
      const segment: Segment = { start, samples, source };
      source.buffer = buffer;
      source.connect(this.analyser);
      source.onended = () => {
        // Rendering can end before the hardware output clock reaches this interval.
        this.releaseSource(segment, false);
        if (!this.closed && !response.cancelled) { this.refresh(); this.armPoll(); }
      };
      response.segments.push(segment); response.received += samples;
      source.start(start);
      this.scheduled = start + samples / QWEN_PLAYBACK_RATE;
      this.armPoll();
      return true;
    } catch { return this.fail('audio_device'); }
  }

  /** response.output_audio.done seals audio; ACK waits for the final output interval. */
  done(id: string): boolean {
    if (this.closed || this.responses.get(id)?.cancelled) return false;
    const response = this.responses.get(id);
    if (!response) return this.fail('response_not_started');
    response.done = true;
    this.refresh(); this.armPoll();
    return !this.closed;
  }

  cursor(id: string): Readonly<{ receivedSamples: number; playedSamples: number; done: boolean; cancelled: boolean }> | undefined {
    if (!this.closed) this.refresh();
    const response = this.responses.get(id);
    return response ? { receivedSamples: response.received, playedSamples: response.played, done: response.done, cancelled: response.cancelled } : undefined;
  }

  /** Immediate local stop + permanent tombstone; return/send only its own conservative cursor. */
  clear(id: string): QwenPlaybackAck | undefined {
    if (this.closed) return undefined;
    let response = this.responses.get(id);
    if (!response) {
      // A cancel can overtake response.created. Its future audio must remain suppressed.
      if (!this.begin(id)) return undefined;
      response = this.responses.get(id)!;
      response.cancelled = true; response.done = true; response.acknowledged = true;
      // There is no registered upstream assistant item to ACK yet.
      return undefined;
    }
    if (response.cancelled) return undefined;
    const time = this.readOutputTime();
    if (time === undefined) return undefined;
    this.measure(response, time);
    response.cancelled = true; response.done = true;
    for (const segment of response.segments) this.releaseSource(segment, true);
    response.segments = [];
    this.recomputeScheduled();
    const ack = this.ack(response);
    if (!response.acknowledged) { response.acknowledged = true; this.options.onAck(ack); }
    return ack;
  }

  clearAll(): QwenPlaybackAck[] {
    const acks: QwenPlaybackAck[] = [];
    for (const id of this.responses.keys()) { const ack = this.clear(id); if (ack) acks.push(ack); }
    return acks;
  }

  /** Teardown emits no captions/ACKs into a potentially different account/session. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.pollEpoch++;
    if (this.poll !== undefined) this.timer.cancel(this.poll);
    this.poll = undefined;
    for (const response of this.responses.values()) {
      for (const segment of response.segments) this.releaseSource(segment, true);
      response.segments = [];
    }
    this.responses.clear(); this.scheduled = 0;
    this.analyser.disconnect();
    this.closePromise = Promise.resolve().then(() => this.context.close());
    return this.closePromise;
  }

  private fail(code: QwenPlaybackError): false {
    if (!this.closed) {
      void this.close().catch(() => {});
      this.options.onError?.(code);
    }
    return false;
  }
  private ack(response: ResponsePlayback): QwenPlaybackAck {
    // The pinned profile quantizes its played-sample cursor to the nearest millisecond.
    const milliseconds = Math.round(response.played * 1000 / QWEN_PLAYBACK_RATE);
    return { type: 'playback.ack', response_id: response.id, item_id: `item_${response.id}`, played_ms: milliseconds, committed_ms: milliseconds };
  }
  private readOutputTime(): number | undefined {
    const rendered = this.context.currentTime;
    if (!Number.isFinite(rendered) || rendered < this.renderTime || this.context.state === 'closed') { this.fail('output_clock'); return; }
    this.renderTime = rendered;
    let output: number | undefined;
    try {
      const timestamp = this.context.getOutputTimestamp?.();
      if (timestamp && typeof timestamp.contextTime === 'number' && Number.isFinite(timestamp.contextTime) && timestamp.contextTime >= 0 && timestamp.contextTime <= rendered &&
          typeof timestamp.performanceTime === 'number' && Number.isFinite(timestamp.performanceTime) && timestamp.performanceTime > 0) output = timestamp.contextTime;
    } catch { /* Older browsers use the conservative latency fallback. */ }
    if (output === undefined) {
      const latency = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! >= 0 ? value! : fallback;
      output = Math.max(0, rendered - latency(this.context.baseLatency, .01) - latency(this.context.outputLatency, .1));
    }
    this.outputTime = Math.max(this.outputTime, output);
    return this.outputTime;
  }
  private measure(response: ResponsePlayback, output: number) {
    let played = response.retired;
    const pending: Segment[] = [];
    for (const segment of response.segments) {
      const count = Math.min(segment.samples, Math.max(0, Math.floor((output - segment.start) * QWEN_PLAYBACK_RATE + 1e-6)));
      played += count;
      if (count === segment.samples) { response.retired += count; this.releaseSource(segment, false); }
      else pending.push(segment);
    }
    response.segments = pending;
    response.played = Math.max(response.played, played);
  }
  private refresh() {
    if (this.closed) return;
    const output = this.readOutputTime(); if (output === undefined) return;
    let progress = 0;
    for (const response of this.responses.values()) {
      if (response.cancelled) continue;
      this.measure(response, output); progress += response.played;
      if (response.done && !response.acknowledged && response.played === response.received) {
        response.acknowledged = true;
        this.options.onAck(this.ack(response));
        if (this.closed) return;
      }
    }
    if (progress !== this.progressSamples || !this.queuedSamples) { this.progressSamples = progress; this.progressAt = this.timer.now(); }
    else if (this.timer.now() - this.progressAt >= QWEN_OUTPUT_STALL_MS) this.fail('output_stalled');
  }
  private armPoll() {
    if (this.closed || this.poll !== undefined || !this.queuedSamples) return;
    const epoch = this.pollEpoch;
    this.poll = this.timer.schedule(() => {
      if (this.closed || epoch !== this.pollEpoch) return;
      this.poll = undefined; this.refresh(); this.armPoll();
    }, 20);
  }
  private recomputeScheduled() {
    this.scheduled = this.context.currentTime;
    for (const response of this.responses.values()) for (const segment of response.segments)
      this.scheduled = Math.max(this.scheduled, segment.start + segment.samples / QWEN_PLAYBACK_RATE);
  }
  private releaseSource(segment: Segment, stop: boolean) {
    const source = segment.source; if (!source) return;
    segment.source = undefined; source.onended = null;
    if (stop) { try { source.stop(); } catch { /* already ended */ } }
    source.disconnect(); source.buffer = null;
  }
}
