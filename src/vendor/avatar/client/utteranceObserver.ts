/** A bounded observer of the existing microphone. Native voice keeps its own clock. */
export interface Utterance {
  chunks: Float32Array[];
  sampleRate: number;
  capped: boolean;
}

export class UtteranceCollector {
  private pre: Float32Array[] = [];
  private preSamples = 0;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private onset = 0;
  private quiet = 0;
  private active = false;
  private draining = false;
  constructor(readonly sampleRate: number, readonly maximumSeconds = 25) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 192000) throw new RangeError('Invalid microphone rate.');
    if (!Number.isFinite(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 25) throw new RangeError('Invalid utterance limit.');
  }
  reset() {
    this.pre.forEach(chunk => chunk.fill(0)); this.chunks.forEach(chunk => chunk.fill(0));
    this.pre = []; this.preSamples = 0; this.chunks = []; this.samples = 0;
    this.onset = 0; this.quiet = 0; this.active = false; this.draining = false;
  }
  push(samples: Float32Array, voiced: boolean): Utterance | undefined {
    if (!(samples instanceof Float32Array) || !samples.length || samples.length > this.sampleRate) return;
    const duration = samples.length / this.sampleRate;
    this.quiet = voiced ? 0 : this.quiet + duration;
    if (this.draining) { if (this.quiet >= .5) this.reset(); return; }
    if (!this.active) {
      this.onset = voiced ? this.onset + duration : 0;
      this.pre.push(samples.slice()); this.preSamples += samples.length;
      const maximum = Math.ceil(this.sampleRate * (.2 + this.onset));
      while (this.preSamples > maximum) {
        const first = this.pre[0], excess = this.preSamples - maximum;
        if (first.length <= excess) { this.pre.shift(); this.preSamples -= first.length; }
        else { this.pre[0] = first.slice(excess); this.preSamples -= excess; }
      }
      if (this.onset < .12) return;
      this.active = true; this.chunks = this.pre; this.samples = this.preSamples;
      this.pre = []; this.preSamples = 0;
    } else {
      const remaining = Math.max(0, Math.floor(this.sampleRate * this.maximumSeconds) - this.samples);
      const chunk = samples.slice(0, remaining);
      if (chunk.length) { this.chunks.push(chunk); this.samples += chunk.length; }
    }
    const capped = this.samples >= this.sampleRate * this.maximumSeconds;
    if (!capped && this.quiet < .5) return;
    const result = { chunks: this.chunks, sampleRate: this.sampleRate, capped };
    this.chunks = []; this.samples = 0; this.active = false; this.onset = 0;
    this.draining = capped && this.quiet < .5;
    if (!this.draining) this.reset();
    return result;
  }
}

/** One in-flight observation and one latest queued utterance; identity changes erase both. */
export class UtteranceObserver {
  private epoch = 0;
  private active?: AbortController;
  private queued?: Utterance;
  private disposed = false;
  constructor(
    private readonly request: (utterance: Utterance, signal: AbortSignal) => Promise<string>,
    private readonly result: (text: string) => void,
    private readonly failure: () => void = () => {},
  ) {}
  offer(utterance: Utterance) {
    if (this.disposed || utterance.capped) return;
    if (this.active) { this.queued = utterance; return; }
    this.start(utterance);
  }
  invalidate() { this.epoch++; this.active?.abort(); this.active = undefined; this.queued = undefined; }
  dispose() { this.disposed = true; this.invalidate(); }
  private start(utterance: Utterance) {
    const controller = new AbortController(), epoch = this.epoch;
    this.active = controller;
    void Promise.resolve().then(() => {
      if (this.disposed || controller.signal.aborted || epoch !== this.epoch) return '';
      return this.request(utterance, controller.signal);
    }).then(text => {
      if (this.disposed || controller.signal.aborted || epoch !== this.epoch) return;
      if (typeof text !== 'string' || text.length > 8000) throw new Error('Invalid observation.');
      if (text.trim()) this.result(text.trim());
    }).catch(() => {
      if (!this.disposed && !controller.signal.aborted && epoch === this.epoch) this.failure();
    }).finally(() => {
      if (this.active !== controller) return;
      this.active = undefined;
      const next = this.queued; this.queued = undefined;
      if (next && !this.disposed) this.start(next);
    });
  }
}
