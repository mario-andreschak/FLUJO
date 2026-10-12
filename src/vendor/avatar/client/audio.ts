export function wavFromPcm(chunks: Float32Array[], sourceRate: number, targetRate = 16000): Uint8Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isInteger(targetRate) || targetRate <= 0) throw new RangeError('Audio sample rates must be positive.');
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(count); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  const length = Math.floor(count * targetRate / sourceRate);
  const buffer = new ArrayBuffer(44 + length * 2); const view = new DataView(buffer);
  const label = (pos: number, value: string) => [...value].forEach((c, i) => view.setUint8(pos + i, c.charCodeAt(0)));
  label(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    // Weight fractional boundary samples as well; 44.1kHz does not divide 16kHz.
    // Averaging an interval preserves level and reduces high-frequency aliasing.
    const from = i * sourceRate / targetRate, to = Math.min(count, (i + 1) * sourceRate / targetRate);
    let sum = 0;
    for (let j = Math.floor(from); j < Math.ceil(to); j++) {
      const weight = Math.min(j + 1, to) - Math.max(j, from);
      sum += (Number.isFinite(joined[j]) ? joined[j] : 0) * weight;
    }
    const value = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new Uint8Array(buffer);
}

/** HTTP chunks may split in the middle of a signed little-endian sample. */
export class Pcm16Stream {
  private carry: number | undefined;
  decode(bytes: Uint8Array): Float32Array {
    const result = new Float32Array(Math.floor((bytes.length + (this.carry === undefined ? 0 : 1)) / 2));
    let offset = 0, index = 0;
    const signed = (value: number) => (value >= 32768 ? value - 65536 : value) / 32768;
    if (this.carry !== undefined && bytes.length) {
      result[index++] = signed(this.carry | (bytes[offset++] << 8));
      this.carry = undefined;
    }
    while (offset + 1 < bytes.length) {
      result[index++] = signed(bytes[offset] | (bytes[offset + 1] << 8));
      offset += 2;
    }
    if (offset < bytes.length) this.carry = bytes[offset];
    return result;
  }
  finish() {
    if (this.carry !== undefined) throw new Error('The voice stream ended in the middle of an audio sample.');
  }
}

/** Round-trip decoded PCM16 exactly; used only for already quantized initial audio. */
export function pcm16FromFloat32(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true);
  }
  return bytes;
}

/** Continuous raw PCM: carry fractional sample intervals across worklet blocks. */
export class Pcm16Resampler {
  private readonly ratio: number;
  private remaining: number;
  private weighted = 0;
  constructor(sourceRate: number, targetRate = 16000) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isInteger(targetRate) || targetRate <= 0) throw new RangeError('Audio sample rates must be positive.');
    this.ratio = sourceRate / targetRate; this.remaining = this.ratio;
  }
  encode(samples: Float32Array): Uint8Array {
    const values: number[] = [];
    for (const sample of samples) {
      let available = 1;
      const value = Number.isFinite(sample) ? sample : 0;
      while (available > 1e-10) {
        const weight = Math.min(available, this.remaining);
        this.weighted += value * weight; this.remaining -= weight; available -= weight;
        if (this.remaining < 1e-10) {
          const amplitude = Math.max(-1, Math.min(1, this.weighted / this.ratio));
          values.push(amplitude < 0 ? amplitude * 32768 : amplitude * 32767);
          this.weighted = 0; this.remaining = this.ratio;
        }
      }
    }
    const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, true));
    return bytes;
  }
  reset() { this.weighted = 0; this.remaining = this.ratio; }
}

/** Coalesce short acknowledgements, and drain every completed sentence in a delta. */
export function speechSentences(text: string, minimum = 12): { ready: string[]; pending: string } {
  const ready: string[] = []; let consumed = 0;
  for (const match of text.matchAll(/[.!?。！？]+(?:\s+|$)/g)) {
    const end = match.index + match[0].length;
    const sentence = text.slice(consumed, end).trim();
    if (sentence.length >= minimum) { ready.push(sentence); consumed = end; }
  }
  return { ready, pending: text.slice(consumed) };
}

export function splitSpeechText(text: string, maximum = 1200): string[] {
  if (!Number.isInteger(maximum) || maximum < 2) throw new RangeError('Speech chunks must allow at least two characters.');
  const chunks: string[] = []; let pending = text.trim();
  while (pending.length > maximum) {
    let end = pending.lastIndexOf(' ', maximum);
    if (end < maximum / 2) end = maximum;
    // Preserve supplementary Unicode characters at a forced token boundary.
    const last = pending.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    chunks.push(pending.slice(0,end).trim()); pending=pending.slice(end).trimStart();
  }
  if(pending) chunks.push(pending);
  return chunks;
}

export function boundedVoiceHistory<T extends { role: 'user' | 'assistant'; content: string }>(history: T[]): T[] {
  const result:T[]=[]; let characters=0;
  for(let index=history.length-1; index>=0 && result.length<10; index--) {
    const item=history[index]; if(!item.content.trim()) continue;
    const content=item.content.slice(-4000);
    if(characters+content.length>8000) break;
    result.unshift({...item,content}); characters+=content.length;
  }
  return result;
}
export function base64Bytes(bytes: Uint8Array): string {
  let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

export async function readNdjson(response: Response, onEvent: (event: Record<string, unknown>) => void) {
  if (!response.body) throw new Error('The voice response was empty.');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '', completed = false;
  const emit = (line: string) => {
    if (!line.trim()) return;
    if (line.length > 128_000) throw new Error('The voice response exceeded its limit.');
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The voice response contained an invalid event.');
    onEvent(value as Record<string, unknown>);
  };
  try {
    while (true) {
      const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) emit(line);
      if (pending.length > 128_000) throw new Error('The voice response exceeded its limit.');
      if (done) { emit(pending); completed = true; break; }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
