'use client';
"use client";
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/client/useNativeRouterVoice.ts
import { useCallback, useEffect, useRef, useState } from "react";

// src/client/audio.ts
function wavFromPcm(chunks, sourceRate, targetRate = 16e3) {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isInteger(targetRate) || targetRate <= 0) throw new RangeError("Audio sample rates must be positive.");
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const length = Math.floor(count * targetRate / sourceRate);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const label = (pos, value) => [...value].forEach((c, i) => view.setUint8(pos + i, c.charCodeAt(0)));
  label(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
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
var Pcm16Stream = class {
  constructor() {
    __publicField(this, "carry");
  }
  decode(bytes) {
    const result = new Float32Array(Math.floor((bytes.length + (this.carry === void 0 ? 0 : 1)) / 2));
    let offset = 0, index = 0;
    const signed = (value) => (value >= 32768 ? value - 65536 : value) / 32768;
    if (this.carry !== void 0 && bytes.length) {
      result[index++] = signed(this.carry | bytes[offset++] << 8);
      this.carry = void 0;
    }
    while (offset + 1 < bytes.length) {
      result[index++] = signed(bytes[offset] | bytes[offset + 1] << 8);
      offset += 2;
    }
    if (offset < bytes.length) this.carry = bytes[offset];
    return result;
  }
  finish() {
    if (this.carry !== void 0) throw new Error("The voice stream ended in the middle of an audio sample.");
  }
};
function base64Bytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

// src/client/locale.ts
var DEFAULT_LOCALE = "en";
function normalizeLocale(value) {
  return value === "es" || value === "pt" ? value : DEFAULT_LOCALE;
}

// src/client/voiceLocale.ts
var es = {
  browserRequired: "La voz necesita acceso al micr\xF3fono en una conexi\xF3n segura. Puedes escribir.",
  playbackBlocked: "Activa el sonido para escuchar la voz.",
  microphoneDenied: "Habilita el micr\xF3fono o usa el teclado.",
  streamFailed: "La voz se interrumpi\xF3. Puedes volver a conectarte o escribir.",
  unsupportedAudio: "El audio no es compatible.",
  speechUnrecognized: "No pude reconocer lo que dijiste. Intenta de nuevo.",
  recordingTooLong: "Hablemos en frases de menos de 25 segundos.",
  messageTooLong: "Usa mensajes de menos de 4000 caracteres.",
  providerUnavailable: "La voz no est\xE1 disponible. Puedes escribir."
};
var pt = {
  browserRequired: "A voz precisa de acesso ao microfone em uma conex\xE3o segura. Voc\xEA pode escrever.",
  playbackBlocked: "Ative o som para ouvir a voz.",
  microphoneDenied: "Ative o microfone ou use o teclado.",
  streamFailed: "A voz foi interrompida. Voc\xEA pode conectar novamente ou escrever.",
  unsupportedAudio: "O \xE1udio n\xE3o \xE9 compat\xEDvel.",
  speechUnrecognized: "N\xE3o reconheci o que voc\xEA disse. Tente novamente.",
  recordingTooLong: "Vamos falar em frases de menos de 25 segundos.",
  messageTooLong: "Use mensagens com menos de 4000 caracteres.",
  providerUnavailable: "A voz est\xE1 indispon\xEDvel. Voc\xEA pode escrever."
};
var en = {
  browserRequired: "Voice needs microphone access on a secure connection. You can type.",
  playbackBlocked: "Enable sound to hear the voice.",
  microphoneDenied: "Enable the microphone or use text.",
  streamFailed: "Voice was interrupted. Reconnect or use text.",
  unsupportedAudio: "The audio format is incompatible.",
  speechUnrecognized: "I couldn\u2019t recognize that. Try again.",
  recordingTooLong: "Use phrases shorter than 25 seconds.",
  messageTooLong: "Use messages shorter than 4000 characters.",
  providerUnavailable: "Voice is unavailable. You can type."
};
function voiceCopy(locale) {
  return { es, pt, en }[locale];
}
var VoiceLocaleError = class extends Error {
  constructor(key) {
    super(key);
    __publicField(this, "key", key);
  }
};
function voiceError(locale, error, fallback = "providerUnavailable") {
  return voiceCopy(locale)[error instanceof VoiceLocaleError ? error.key : fallback];
}
function voiceRequestError(_status, _code) {
  return new VoiceLocaleError("providerUnavailable");
}
async function voiceResponseError(response) {
  await response.body?.cancel();
  return new VoiceLocaleError("providerUnavailable");
}

// src/client/utteranceObserver.ts
var UtteranceCollector = class {
  constructor(sampleRate, maximumSeconds = 25) {
    __publicField(this, "sampleRate", sampleRate);
    __publicField(this, "maximumSeconds", maximumSeconds);
    __publicField(this, "pre", []);
    __publicField(this, "preSamples", 0);
    __publicField(this, "chunks", []);
    __publicField(this, "samples", 0);
    __publicField(this, "onset", 0);
    __publicField(this, "quiet", 0);
    __publicField(this, "active", false);
    __publicField(this, "draining", false);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 192e3) throw new RangeError("Invalid microphone rate.");
    if (!Number.isFinite(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 25) throw new RangeError("Invalid utterance limit.");
  }
  reset() {
    this.pre.forEach((chunk) => chunk.fill(0));
    this.chunks.forEach((chunk) => chunk.fill(0));
    this.pre = [];
    this.preSamples = 0;
    this.chunks = [];
    this.samples = 0;
    this.onset = 0;
    this.quiet = 0;
    this.active = false;
    this.draining = false;
  }
  push(samples, voiced) {
    if (!(samples instanceof Float32Array) || !samples.length || samples.length > this.sampleRate) return;
    const duration = samples.length / this.sampleRate;
    this.quiet = voiced ? 0 : this.quiet + duration;
    if (this.draining) {
      if (this.quiet >= 0.5) this.reset();
      return;
    }
    if (!this.active) {
      this.onset = voiced ? this.onset + duration : 0;
      this.pre.push(samples.slice());
      this.preSamples += samples.length;
      const maximum = Math.ceil(this.sampleRate * (0.2 + this.onset));
      while (this.preSamples > maximum) {
        const first = this.pre[0], excess = this.preSamples - maximum;
        if (first.length <= excess) {
          this.pre.shift();
          this.preSamples -= first.length;
        } else {
          this.pre[0] = first.slice(excess);
          this.preSamples -= excess;
        }
      }
      if (this.onset < 0.12) return;
      this.active = true;
      this.chunks = this.pre;
      this.samples = this.preSamples;
      this.pre = [];
      this.preSamples = 0;
    } else {
      const remaining = Math.max(0, Math.floor(this.sampleRate * this.maximumSeconds) - this.samples);
      const chunk = samples.slice(0, remaining);
      if (chunk.length) {
        this.chunks.push(chunk);
        this.samples += chunk.length;
      }
    }
    const capped = this.samples >= this.sampleRate * this.maximumSeconds;
    if (!capped && this.quiet < 0.5) return;
    const result = { chunks: this.chunks, sampleRate: this.sampleRate, capped };
    this.chunks = [];
    this.samples = 0;
    this.active = false;
    this.onset = 0;
    this.draining = capped && this.quiet < 0.5;
    if (!this.draining) this.reset();
    return result;
  }
};

// src/client/qwenPlayback.ts
var QWEN_PLAYBACK_RATE = 24e3;
var QWEN_MAX_CHUNK_SAMPLES = QWEN_PLAYBACK_RATE * 4;
var QWEN_MAX_QUEUED_SAMPLES = QWEN_PLAYBACK_RATE * 5;
var QWEN_MAX_RESPONSE_SAMPLES = QWEN_PLAYBACK_RATE * 31;
var QWEN_MAX_RESPONSE_IDS = 128;
var QWEN_MAX_PENDING_SEGMENTS = 512;
var QWEN_OUTPUT_STALL_MS = 5e3;
var browserTimer = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (handle) => clearTimeout(handle)
};
var identifier = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
var QwenPlayback = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "context");
    __publicField(this, "analyser");
    __publicField(this, "timer");
    __publicField(this, "responses", /* @__PURE__ */ new Map());
    __publicField(this, "poll");
    __publicField(this, "pollEpoch", 0);
    __publicField(this, "closed", false);
    __publicField(this, "closePromise");
    __publicField(this, "outputTime", 0);
    __publicField(this, "renderTime", 0);
    __publicField(this, "scheduled", 0);
    __publicField(this, "progressAt");
    __publicField(this, "progressSamples", 0);
    this.timer = options.timer ?? browserTimer;
    this.progressAt = this.timer.now();
    this.context = (options.createContext ?? (() => new AudioContext({ sampleRate: QWEN_PLAYBACK_RATE })))();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.context.destination);
  }
  get isClosed() {
    return this.closed;
  }
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
  isSuppressed(id) {
    return this.closed || this.responses.get(id)?.cancelled === true;
  }
  async resume() {
    if (this.closed) return false;
    try {
      await this.context.resume();
    } catch {
      this.fail("audio_device");
      return false;
    }
    return !this.closed;
  }
  /** Called for response.created; IDs can never be reused, even after drain. */
  begin(id) {
    if (this.closed) return false;
    if (!identifier(id)) return this.fail("invalid_response");
    if (this.responses.has(id)) return false;
    if (this.responses.size >= QWEN_MAX_RESPONSE_IDS) return this.fail("playback_capacity");
    this.responses.set(id, { id, received: 0, played: 0, retired: 0, segments: [], done: false, acknowledged: false, cancelled: false });
    return true;
  }
  /** A wire delta contains complete little-endian PCM16 samples at24k, without a WAV header. */
  enqueue(id, bytes) {
    if (this.closed || this.responses.get(id)?.cancelled) return false;
    const response = this.responses.get(id);
    if (!response) return this.fail("response_not_started");
    if (response.done) return this.fail("audio_after_done");
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > QWEN_MAX_CHUNK_SAMPLES * 2) return this.fail("invalid_pcm");
    this.refresh();
    if (this.closed || response.cancelled) return false;
    const samples = bytes.length / 2;
    if (this.queuedSamples + samples > QWEN_MAX_QUEUED_SAMPLES || response.received + samples > QWEN_MAX_RESPONSE_SAMPLES || this.pendingSegments >= QWEN_MAX_PENDING_SEGMENTS) return this.fail("playback_capacity");
    try {
      const pcm = new Pcm16Stream().decode(bytes);
      const buffer = this.context.createBuffer(1, samples, QWEN_PLAYBACK_RATE);
      buffer.getChannelData(0).set(pcm);
      const source = this.context.createBufferSource();
      const start = Math.max(this.scheduled, this.context.currentTime + 0.025);
      const segment = { start, samples, source };
      source.buffer = buffer;
      source.connect(this.analyser);
      source.onended = () => {
        this.releaseSource(segment, false);
        if (!this.closed && !response.cancelled) {
          this.refresh();
          this.armPoll();
        }
      };
      response.segments.push(segment);
      response.received += samples;
      source.start(start);
      this.scheduled = start + samples / QWEN_PLAYBACK_RATE;
      this.armPoll();
      return true;
    } catch {
      return this.fail("audio_device");
    }
  }
  /** response.output_audio.done seals audio; ACK waits for the final output interval. */
  done(id) {
    if (this.closed || this.responses.get(id)?.cancelled) return false;
    const response = this.responses.get(id);
    if (!response) return this.fail("response_not_started");
    response.done = true;
    this.refresh();
    this.armPoll();
    return !this.closed;
  }
  cursor(id) {
    if (!this.closed) this.refresh();
    const response = this.responses.get(id);
    return response ? { receivedSamples: response.received, playedSamples: response.played, done: response.done, cancelled: response.cancelled } : void 0;
  }
  /** Immediate local stop + permanent tombstone; return/send only its own conservative cursor. */
  clear(id) {
    if (this.closed) return void 0;
    let response = this.responses.get(id);
    if (!response) {
      if (!this.begin(id)) return void 0;
      response = this.responses.get(id);
      response.cancelled = true;
      response.done = true;
      response.acknowledged = true;
      return void 0;
    }
    if (response.cancelled) return void 0;
    const time = this.readOutputTime();
    if (time === void 0) return void 0;
    this.measure(response, time);
    response.cancelled = true;
    response.done = true;
    for (const segment of response.segments) this.releaseSource(segment, true);
    response.segments = [];
    this.recomputeScheduled();
    const ack = this.ack(response);
    if (!response.acknowledged) {
      response.acknowledged = true;
      this.options.onAck(ack);
    }
    return ack;
  }
  clearAll() {
    const acks = [];
    for (const id of this.responses.keys()) {
      const ack = this.clear(id);
      if (ack) acks.push(ack);
    }
    return acks;
  }
  /** Teardown emits no captions/ACKs into a potentially different account/session. */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.pollEpoch++;
    if (this.poll !== void 0) this.timer.cancel(this.poll);
    this.poll = void 0;
    for (const response of this.responses.values()) {
      for (const segment of response.segments) this.releaseSource(segment, true);
      response.segments = [];
    }
    this.responses.clear();
    this.scheduled = 0;
    this.analyser.disconnect();
    this.closePromise = Promise.resolve().then(() => this.context.close());
    return this.closePromise;
  }
  fail(code) {
    if (!this.closed) {
      void this.close().catch(() => {
      });
      this.options.onError?.(code);
    }
    return false;
  }
  ack(response) {
    const milliseconds = Math.round(response.played * 1e3 / QWEN_PLAYBACK_RATE);
    return { type: "playback.ack", response_id: response.id, item_id: `item_${response.id}`, played_ms: milliseconds, committed_ms: milliseconds };
  }
  readOutputTime() {
    const rendered = this.context.currentTime;
    if (!Number.isFinite(rendered) || rendered < this.renderTime || this.context.state === "closed") {
      this.fail("output_clock");
      return;
    }
    this.renderTime = rendered;
    let output;
    try {
      const timestamp = this.context.getOutputTimestamp?.();
      if (timestamp && typeof timestamp.contextTime === "number" && Number.isFinite(timestamp.contextTime) && timestamp.contextTime >= 0 && timestamp.contextTime <= rendered && typeof timestamp.performanceTime === "number" && Number.isFinite(timestamp.performanceTime) && timestamp.performanceTime > 0) output = timestamp.contextTime;
    } catch {
    }
    if (output === void 0) {
      const latency = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
      output = Math.max(0, rendered - latency(this.context.baseLatency, 0.01) - latency(this.context.outputLatency, 0.1));
    }
    this.outputTime = Math.max(this.outputTime, output);
    return this.outputTime;
  }
  measure(response, output) {
    let played = response.retired;
    const pending = [];
    for (const segment of response.segments) {
      const count = Math.min(segment.samples, Math.max(0, Math.floor((output - segment.start) * QWEN_PLAYBACK_RATE + 1e-6)));
      played += count;
      if (count === segment.samples) {
        response.retired += count;
        this.releaseSource(segment, false);
      } else pending.push(segment);
    }
    response.segments = pending;
    response.played = Math.max(response.played, played);
  }
  refresh() {
    if (this.closed) return;
    const output = this.readOutputTime();
    if (output === void 0) return;
    let progress = 0;
    for (const response of this.responses.values()) {
      if (response.cancelled) continue;
      this.measure(response, output);
      progress += response.played;
      if (response.done && !response.acknowledged && response.played === response.received) {
        response.acknowledged = true;
        this.options.onAck(this.ack(response));
        if (this.closed) return;
      }
    }
    if (progress !== this.progressSamples || !this.queuedSamples) {
      this.progressSamples = progress;
      this.progressAt = this.timer.now();
    } else if (this.timer.now() - this.progressAt >= QWEN_OUTPUT_STALL_MS) this.fail("output_stalled");
  }
  armPoll() {
    if (this.closed || this.poll !== void 0 || !this.queuedSamples) return;
    const epoch = this.pollEpoch;
    this.poll = this.timer.schedule(() => {
      if (this.closed || epoch !== this.pollEpoch) return;
      this.poll = void 0;
      this.refresh();
      this.armPoll();
    }, 20);
  }
  recomputeScheduled() {
    this.scheduled = this.context.currentTime;
    for (const response of this.responses.values()) for (const segment of response.segments)
      this.scheduled = Math.max(this.scheduled, segment.start + segment.samples / QWEN_PLAYBACK_RATE);
  }
  releaseSource(segment, stop) {
    const source = segment.source;
    if (!source) return;
    segment.source = void 0;
    source.onended = null;
    if (stop) {
      try {
        source.stop();
      } catch {
      }
    }
    source.disconnect();
    source.buffer = null;
  }
};

// src/client/nativeRouterPlayback.ts
var NATIVE_ROUTER_RATE = 24e3;
var NATIVE_ROUTER_RATE_QUALIFICATION = "assumed";
var MAX_WIRE_BYTES = 4 * 1024 * 1024;
var MAX_EVENT_CHARS = 2 * 1024 * 1024;
var FRAME_SAMPLES = NATIVE_ROUTER_RATE;
var nativeIdentifier = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
var invalid = () => {
  throw new Error("invalid_native_stream");
};
var record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
function nativeAudioBytes(data) {
  if (typeof data !== "string" || !data.length || data.length > MAX_EVENT_CHARS || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return invalid();
  let binary;
  try {
    binary = atob(data);
  } catch {
    return invalid();
  }
  if (btoa(binary) !== data) return invalid();
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
var NativeTurnProtocol = class {
  constructor() {
    __publicField(this, "turnId");
    __publicField(this, "terminal", false);
    __publicField(this, "bytes", 0);
    __publicField(this, "caption", "");
  }
  accept(value) {
    if (!record(value) || this.terminal || !nativeIdentifier(value.turnId)) return invalid();
    const keys = {
      start: ["type", "turnId", "sampleRate", "sampleRateQualification"],
      audio: ["type", "turnId", "data"],
      caption: ["type", "turnId", "text"],
      complete: ["type", "turnId", "text", "samples", "usage"],
      error: ["type", "turnId", "code", "error"]
    };
    const allowed = typeof value.type === "string" ? keys[value.type] : void 0;
    if (!allowed || Object.keys(value).some((key) => !allowed.includes(key))) return invalid();
    if (value.type === "start") {
      if (this.turnId || value.sampleRate !== NATIVE_ROUTER_RATE || value.sampleRateQualification !== NATIVE_ROUTER_RATE_QUALIFICATION) return invalid();
      this.turnId = value.turnId;
    } else {
      if (!this.turnId || value.turnId !== this.turnId) return invalid();
      if (value.type === "audio") {
        if (typeof value.data !== "string") return invalid();
        this.bytes += nativeAudioBytes(value.data).length;
        if (this.bytes > QWEN_MAX_RESPONSE_SAMPLES * 2) return invalid();
      } else if (value.type === "caption" || value.type === "complete") {
        if (typeof value.text !== "string" || value.text.length > 8e3 || !value.text.startsWith(this.caption)) return invalid();
        this.caption = value.text;
        if (value.type === "complete") {
          if (!Number.isInteger(value.samples) || Number(value.samples) <= 0 || Number(value.samples) !== this.bytes / 2 || !record(value.usage) || JSON.stringify(value.usage).length > 4096) return invalid();
          this.terminal = true;
        }
      } else if (value.type === "error") {
        if (typeof value.code !== "string" || !/^[a-z_]{1,80}$/.test(value.code) || value.error !== void 0 && (typeof value.error !== "string" || value.error.length > 500)) return invalid();
        this.terminal = true;
      }
    }
    return value;
  }
  finish() {
    if (!this.terminal) invalid();
  }
};
function aborted() {
  return new DOMException("The native turn was cancelled.", "AbortError");
}
function nativeAbortable(promise, signal) {
  if (signal.aborted) {
    void promise.catch(() => {
    });
    return Promise.reject(aborted());
  }
  return new Promise((resolve, reject) => {
    const cancel = () => {
      cleanup();
      reject(aborted());
    };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    promise.then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function readNativeTurn(response, signal, event) {
  if (!response.body || !/^application\/(?:x-)?ndjson(?:;|$)/i.test(response.headers.get("content-type") ?? "")) invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const protocol = new NativeTurnProtocol();
  let pending = "", size = 0, ended = false;
  const line = async (text) => {
    if (signal.aborted) throw aborted();
    if (!text.trim()) return;
    if (text.length > MAX_EVENT_CHARS) invalid();
    await event(protocol.accept(JSON.parse(text)));
    if (signal.aborted) throw aborted();
  };
  try {
    while (true) {
      const result = await nativeAbortable(reader.read(), signal);
      if (result.done) {
        ended = true;
        break;
      }
      size += result.value.byteLength;
      if (size > MAX_WIRE_BYTES) invalid();
      pending += decoder.decode(result.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const next = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await line(next);
      }
      if (pending.length > MAX_EVENT_CHARS) invalid();
    }
    pending += decoder.decode();
    if (pending.trim()) await line(pending);
    protocol.finish();
  } finally {
    if (!ended) {
      let timer;
      try {
        await Promise.race([reader.cancel().catch(() => {
        }), new Promise((resolve) => {
          timer = setTimeout(resolve, 100);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
var defaultTimer = {
  now: () => performance.now(),
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (handle) => clearTimeout(handle)
};
var NativeRouterPlayback = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "player");
    __publicField(this, "timer");
    __publicField(this, "turns", /* @__PURE__ */ new Map());
    __publicField(this, "closed", false);
    this.timer = options.timer ?? defaultTimer;
    this.player = new QwenPlayback({
      createContext: options.createContext,
      timer: this.timer,
      onError: () => {
        this.invalidate();
        options.onError?.();
      },
      onAck: (ack) => {
        const turn = this.turns.get(ack.response_id), cursor = this.player.cursor(ack.response_id);
        if (this.closed || !turn || !cursor || turn.receiptEmitted) return;
        const complete = turn.sealed && !turn.cancelled && cursor.done && cursor.receivedSamples > 0 && cursor.receivedSamples === cursor.playedSamples;
        if (!turn.cancelled && !complete) return;
        turn.receiptEmitted = true;
        options.onPlayed({ turnId: ack.response_id, playedSamples: cursor.playedSamples, complete });
      }
    });
  }
  get context() {
    return this.player.context;
  }
  get analyser() {
    return this.player.analyser;
  }
  get queuedSamples() {
    return this.player.queuedSamples;
  }
  get isClosed() {
    return this.closed || this.player.isClosed;
  }
  resume() {
    return this.player.resume();
  }
  begin(turnId) {
    if (this.closed || this.turns.has(turnId) || !nativeIdentifier(turnId) || !this.player.begin(turnId)) return false;
    this.turns.set(turnId, { controller: new AbortController(), sealed: false, cancelled: false, receiptEmitted: false, received: 0, writer: false });
    return true;
  }
  wait(ms, signal) {
    if (signal.aborted || this.isClosed) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.timer.cancel(handle);
        signal.removeEventListener("abort", cancel);
        reject(aborted());
      };
      const handle = this.timer.schedule(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  async enqueue(turnId, bytes, signal) {
    const turn = this.turns.get(turnId);
    if (!turn || turn.sealed || turn.cancelled || turn.writer || this.isClosed || !(bytes instanceof Uint8Array) || !bytes.length) throw aborted();
    const combined = AbortSignal.any([signal, turn.controller.signal]);
    if (combined.aborted) throw aborted();
    if (turn.received + bytes.length > QWEN_MAX_RESPONSE_SAMPLES * 2) invalid();
    turn.writer = true;
    try {
      const joined = new Uint8Array(bytes.length + (turn.carry === void 0 ? 0 : 1));
      if (turn.carry !== void 0) joined[0] = turn.carry;
      joined.set(bytes, turn.carry === void 0 ? 0 : 1);
      turn.received += bytes.length;
      turn.carry = joined.length % 2 ? joined[joined.length - 1] : void 0;
      const even = joined.length - joined.length % 2;
      for (let offset = 0; offset < even; ) {
        const count = Math.min(FRAME_SAMPLES * 2, even - offset);
        while (true) {
          if (combined.aborted || this.isClosed) throw aborted();
          this.player.cursor(turnId);
          if (this.isClosed) throw aborted();
          if (this.player.queuedSamples + count / 2 <= QWEN_MAX_QUEUED_SAMPLES && this.player.pendingSegments < 512) break;
          await this.wait(20, combined);
        }
        if (combined.aborted || !this.player.enqueue(turnId, joined.subarray(offset, offset + count))) throw aborted();
        offset += count;
      }
    } finally {
      turn.writer = false;
    }
  }
  async drain(turnId, expectedSamples, signal) {
    const turn = this.turns.get(turnId), cursor = this.player.cursor(turnId);
    if (!turn || turn.cancelled || turn.writer || turn.carry !== void 0 || !cursor || !Number.isInteger(expectedSamples) || expectedSamples <= 0 || expectedSamples !== cursor.receivedSamples || expectedSamples * 2 !== turn.received) return invalid();
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
  cancel(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn || turn.cancelled || this.closed) return;
    turn.cancelled = true;
    turn.carry = void 0;
    turn.controller.abort();
    this.player.clear(turnId);
  }
  invalidate() {
    this.closed = true;
    for (const turn of this.turns.values()) turn.controller.abort();
  }
  close() {
    this.invalidate();
    this.turns.clear();
    return this.player.close();
  }
};

// src/client/nativeVoiceTransport.ts
var clientId = () => {
  const key = "flujo-avatar:voice-client";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
};
var voiceHeaders = () => ({ "Content-Type": "application/json", "x-flujo-avatar-client": clientId() });
var localNativeVoiceTransport = Object.freeze({
  scopeKey: "local-native-voice",
  workletUrl: "/avatar-audio-capture.js",
  request: (endpoint, init) => fetch(`/api/avatar/${endpoint}`, init)
});
function snapshotNativeVoiceTransport(value = localNativeVoiceTransport) {
  if (typeof value.scopeKey !== "string" || !value.scopeKey || value.scopeKey.length > 512 || typeof value.workletUrl !== "string" || !value.workletUrl || value.workletUrl.length > 2048 || typeof value.request !== "function") throw new Error("invalid_voice_transport");
  const request = value.request.bind(value);
  return Object.freeze({ scopeKey: value.scopeKey, workletUrl: value.workletUrl, request });
}
var resetBarriers = /* @__PURE__ */ new Map();
function resetNativeHistory(transport, signal) {
  const next = (resetBarriers.get(transport.scopeKey) ?? Promise.resolve()).catch(() => {
  }).then(async () => {
    const owned = AbortSignal.any([signal, AbortSignal.timeout(5e3)]);
    owned.throwIfAborted();
    const response = await transport.request("native-reset", {
      method: "POST",
      headers: voiceHeaders(),
      body: "{}",
      signal: owned
    });
    if (owned.aborted) {
      await response.body?.cancel();
      owned.throwIfAborted();
    }
    if (!response.ok) throw await voiceResponseError(response);
    await response.body?.cancel();
  });
  const settled = next.catch(() => {
  });
  resetBarriers.set(transport.scopeKey, settled);
  void settled.then(() => {
    if (resetBarriers.get(transport.scopeKey) === settled) resetBarriers.delete(transport.scopeKey);
  });
  return next;
}

// src/client/useNativeRouterVoice.ts
var cancelled = () => new DOMException("The native voice turn was cancelled.", "AbortError");
function useNativeRouterVoice(options) {
  const opts = useRef(options);
  opts.current = options;
  const nextAvatar = useRef({ id: options.avatar, prop: options.avatar });
  if (nextAvatar.current.prop !== options.avatar) nextAvatar.current = { id: options.avatar, prop: options.avatar };
  const session = useRef(null);
  const [connected, setConnected] = useState(false), [connecting, setConnecting] = useState(false);
  const [phase, setPhase] = useState("idle"), [muted, setMuted] = useState(false);
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0), [error, setError] = useState("");
  const pump = useRef(() => {
  }), observe = useRef(() => {
  });
  const fail = useRef(() => {
  });
  const current = useCallback((s) => session.current === s && !s.abort.signal.aborted && s.transport.scopeKey === (opts.current.transport?.scopeKey ?? localNativeVoiceTransport.scopeKey), []);
  const liveTurn = useCallback((s, t) => current(s) && s.response === t && s.generation === t.generation && !t.abort.signal.aborted, [current]);
  const refresh = useCallback((s) => {
    if (!current(s) || !s.ready) return;
    const responding = s.response && !s.response.abort.signal.aborted && s.generation === s.response.generation;
    setPhase(s.capturing ? "listening" : responding ? s.playback?.queuedSamples ? "speaking" : "thinking" : s.muted || !s.stream ? "idle" : "listening");
  }, [current]);
  const invalidateObserver = useCallback((s) => {
    s.observerEpoch++;
    s.observer?.abort();
    s.observer = void 0;
    s.observation = void 0;
  }, []);
  const stopResponse = useCallback((s, hold, dropPending = true) => {
    s.generation++;
    s.manualHold = hold;
    if (dropPending) {
      s.pending = void 0;
      s.results = [];
    }
    const turn = s.response;
    turn?.abort.abort();
    if (turn?.turnId) s.playback?.cancel(turn.turnId);
    setAudioLevel(0);
    if (current(s)) {
      opts.current.onInterrupted?.();
      setPhase(s.muted ? "idle" : "listening");
    }
  }, [current]);
  const disconnect = useCallback(() => {
    const old = session.current;
    session.current = null;
    if (old) {
      opts.current.onInterrupted?.();
      old.abort.abort();
      old.response?.abort.abort();
      invalidateObserver(old);
      old.acknowledgements.forEach((controller) => controller.abort());
      old.acknowledgements.clear();
      old.pending = void 0;
      old.results = [];
      old.resultIds.clear();
      old.collector?.reset();
      if (old.raf !== void 0) cancelAnimationFrame(old.raf);
      if (old.capture) {
        old.capture.port.onmessage = null;
        old.capture.disconnect();
      }
      old.input?.disconnect();
      old.silent?.disconnect();
      old.stream?.getTracks().forEach((track) => track.stop());
      void old.context?.close().catch(() => {
      });
      void old.playback?.close().catch(() => {
      });
    }
    setConnected(false);
    setHasMicrophone(false);
    setConnecting(false);
    setMuted(false);
    setPhase("idle");
    setAudioLevel(0);
  }, [invalidateObserver]);
  fail.current = (s) => {
    if (current(s)) {
      disconnect();
      setError(voiceCopy(s.locale).streamFailed);
    }
  };
  const request = useCallback(async (s, path, body, signal, timeout = 45e3) => {
    if (!current(s)) throw cancelled();
    const response = await s.transport.request(path, {
      method: "POST",
      headers: voiceHeaders(),
      body: JSON.stringify({ ...body, locale: s.locale }),
      signal: AbortSignal.any([signal, s.abort.signal, AbortSignal.timeout(timeout)])
    });
    if (!current(s)) {
      await response.body?.cancel();
      throw cancelled();
    }
    if (!response.ok) {
      const error2 = await voiceResponseError(response);
      if ((response.status === 401 || response.status === 403) && current(s)) {
        disconnect();
        setError(voiceError(s.locale, error2));
      }
      throw error2;
    }
    return response;
  }, [current, disconnect]);
  const played = useCallback((s, receipt) => {
    if (!current(s)) return;
    const accountEpoch = s.accountEpoch;
    const publish = async () => {
      if (!current(s) || accountEpoch !== s.accountEpoch) return;
      const controller = new AbortController();
      s.acknowledgements.add(controller);
      try {
        const response = await request(s, "native-played", receipt, controller.signal, 5e3);
        await response.body?.cancel();
      } finally {
        s.acknowledgements.delete(controller);
      }
    };
    if (receipt.complete) {
      s.ackBarrier = s.ackBarrier.then(publish);
      void s.ackBarrier.catch(() => {
        if (current(s) && accountEpoch === s.accountEpoch) fail.current(s);
      });
    } else void publish().catch(() => {
    });
  }, [current, request]);
  observe.current = (s, item) => {
    if (!current(s) || s.muted || !opts.current.backgroundAsr || opts.current.observerPaused) return;
    if (s.observer) {
      s.observation = item;
      return;
    }
    const controller = new AbortController(), epoch = s.observerEpoch;
    s.observer = controller;
    void request(s, "native-observe", { audio: item.audio, format: "wav", turnId: item.turnId }, controller.signal).then((response) => response.json()).then((body) => {
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" || body.text.length > 8e3) throw new VoiceLocaleError("speechUnrecognized");
      if (!current(s) || controller.signal.aborted || epoch !== s.observerEpoch || item.serial !== s.serial || s.muted || opts.current.observerPaused) return;
      const text = body.text.trim();
      if (!text) return;
      const id = `native-observed-${item.turnId}`;
      if (opts.current.onObservedTranscript) opts.current.onObservedTranscript(id, text);
      else opts.current.onTranscript(id, "user", text, true);
    }).catch(() => {
      if (current(s) && !controller.signal.aborted && epoch === s.observerEpoch && item.serial === s.serial && !s.muted && !opts.current.observerPaused) opts.current.onObserverError?.();
    }).finally(() => {
      if (s.observer !== controller) return;
      s.observer = void 0;
      const next = s.observation;
      s.observation = void 0;
      if (next) observe.current(s, next);
    });
  };
  const process = useCallback(async (s, input) => {
    const turn = { generation: input.generation, abort: new AbortController() };
    s.response = turn;
    const deadline = setTimeout(() => turn.abort.abort(), 45e3);
    refresh(s);
    try {
      await nativeAbortable(s.ackBarrier, turn.abort.signal);
      if (!liveTurn(s, turn)) throw cancelled();
      if (input.audio && input.workInput) {
        const response2 = await request(s, "native-input", { audio: input.audio, format: "wav", avatar: input.avatar }, turn.abort.signal);
        const body = await response2.json();
        if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" || body.text.length > 4e3) throw new VoiceLocaleError("speechUnrecognized");
        if (!liveTurn(s, turn) || input.serial !== s.serial || s.muted || opts.current.observerPaused) return;
        const text = body.text.trim();
        if (text) {
          const id = crypto.randomUUID();
          if (opts.current.onObservedTranscript) opts.current.onObservedTranscript(id, text);
          else opts.current.onTranscript(id, "user", text, true);
        }
        return;
      }
      if (input.message) opts.current.onTranscript(crypto.randomUUID(), "user", input.message, true);
      const path = input.taskId ? "native-result" : "native-turn";
      const payload = input.taskId ? { taskId: input.taskId, avatar: input.avatar } : input.audio ? { audio: input.audio, format: "wav", avatar: input.avatar } : { message: input.message, avatar: input.avatar };
      const response = await request(s, path, payload, turn.abort.signal);
      if (!liveTurn(s, turn)) {
        await response.body?.cancel();
        throw cancelled();
      }
      await readNativeTurn(response, AbortSignal.any([turn.abort.signal, s.abort.signal]), async (event) => {
        if (!liveTurn(s, turn)) throw cancelled();
        if (event.type === "start") {
          turn.turnId = event.turnId;
          if (!s.playback?.begin(event.turnId)) throw new VoiceLocaleError("unsupportedAudio");
          if (input.audio) observe.current(s, { turnId: event.turnId, audio: input.audio, serial: input.serial });
        } else if (event.type === "audio") {
          await s.playback.enqueue(event.turnId, nativeAudioBytes(event.data), turn.abort.signal);
          if (liveTurn(s, turn)) refresh(s);
        } else if (event.type === "caption") {
          opts.current.onTranscript(`native-${event.turnId}`, "assistant", event.text, false);
        } else if (event.type === "complete") turn.complete = event;
        else throw voiceRequestError(502, event.code);
      });
      if (!turn.complete || !turn.turnId || !liveTurn(s, turn)) throw new VoiceLocaleError("streamFailed");
      await s.playback.drain(turn.turnId, turn.complete.samples, turn.abort.signal);
      await nativeAbortable(s.ackBarrier, turn.abort.signal);
      if (liveTurn(s, turn)) opts.current.onTranscript(`native-${turn.turnId}`, "assistant", turn.complete.text, true);
    } catch (e) {
      if (turn.turnId) s.playback?.cancel(turn.turnId);
      if (current(s) && s.response === turn && s.generation === turn.generation) {
        opts.current.onInterrupted?.();
        setError(voiceError(s.locale, e, "streamFailed"));
      }
    } finally {
      clearTimeout(deadline);
      if (s.response === turn) s.response = void 0;
      if (current(s)) {
        refresh(s);
        pump.current(s);
      }
    }
  }, [current, liveTurn, refresh, request]);
  pump.current = (s) => {
    if (!current(s) || !s.ready || s.pumping || s.capturing || s.draining) return;
    const pending = s.pending;
    if (s.muted && pending?.message === void 0 || s.manualHold) return;
    let input = pending;
    if (!input && !s.muted && s.results.length) input = { taskId: s.results.shift(), generation: s.generation, serial: s.serial, avatar: nextAvatar.current.id };
    if (!input) return;
    s.pending = void 0;
    s.pumping = true;
    void process(s, input).finally(() => {
      s.pumping = false;
      if (current(s)) pump.current(s);
    });
  };
  const enqueue = useCallback((s, value) => {
    stopResponse(s, false);
    s.pending = { ...value, workInput: Boolean(opts.current.workInput), avatar: nextAvatar.current.id, generation: s.generation, serial: s.serial };
    pump.current(s);
  }, [stopResponse]);
  const connect = useCallback(async (withMicrophone = true) => {
    if (session.current) {
      if (current(session.current) && (!withMicrophone || session.current.stream)) return;
      disconnect();
    }
    setConnecting(true);
    setError("");
    let transport;
    try {
      transport = snapshotNativeVoiceTransport(opts.current.transport);
    } catch {
      setConnecting(false);
      setError(voiceCopy(normalizeLocale(opts.current.locale)).streamFailed);
      return;
    }
    const s = {
      transport,
      owner: /* @__PURE__ */ Symbol("native-voice-session"),
      accountEpoch: 0,
      abort: new AbortController(),
      locale: normalizeLocale(opts.current.locale),
      ready: false,
      muted: false,
      noise: 2e-3,
      onset: 0,
      quiet: 0,
      capturing: false,
      draining: false,
      inputLevel: 0,
      generation: 0,
      serial: 0,
      pumping: false,
      manualHold: false,
      results: [],
      resultIds: /* @__PURE__ */ new Set(),
      observerEpoch: 0,
      ackBarrier: Promise.resolve(),
      acknowledgements: /* @__PURE__ */ new Set()
    };
    session.current = s;
    try {
      await resetNativeHistory(s.transport, s.abort.signal);
      if (!current(s)) return;
      if (withMicrophone && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)) throw new VoiceLocaleError("browserRequired");
      const context = new AudioContext();
      s.context = context;
      await context.resume();
      if (!current(s)) return;
      s.playback = new NativeRouterPlayback({ onPlayed: (receipt) => played(s, receipt), onError: () => fail.current(s) });
      if (!await s.playback.resume() || !current(s)) throw new VoiceLocaleError("playbackBlocked");
      const meter = new Float32Array(s.playback.analyser.fftSize);
      let last = 0;
      const measure = (now) => {
        if (!current(s)) return;
        if (now - last >= 50) {
          last = now;
          if (s.playback.queuedSamples && !s.capturing) {
            s.playback.analyser.getFloatTimeDomainData(meter);
            let power = 0;
            for (const sample of meter) power += sample * sample;
            setAudioLevel(Math.min(1, Math.sqrt(power / meter.length) * 5));
          } else setAudioLevel(s.muted ? 0 : s.inputLevel);
          refresh(s);
        }
        s.raf = requestAnimationFrame(measure);
      };
      if (!withMicrophone) {
        s.ready = true;
        setConnected(true);
        setConnecting(false);
        setPhase("idle");
        s.raf = requestAnimationFrame(measure);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current(s)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      s.stream = stream;
      await context.audioWorklet.addModule(s.transport.workletUrl);
      if (!current(s)) return;
      const capture = new AudioWorkletNode(context, "voice-capture");
      s.capture = capture;
      s.silent = context.createGain();
      s.silent.gain.value = 0;
      s.input = context.createMediaStreamSource(stream);
      s.input.connect(capture).connect(s.silent).connect(context.destination);
      s.collector = new UtteranceCollector(context.sampleRate, 25);
      capture.port.onmessage = (event) => {
        if (!current(s) || s.muted) return;
        const pcm = event.data;
        if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > context.sampleRate) return;
        let power = 0;
        for (const sample of pcm) power += sample * sample;
        const rms = Math.sqrt(power / pcm.length), seconds = pcm.length / context.sampleRate;
        s.inputLevel = Math.min(1, rms * 5);
        const voiced = rms > Math.max(0.012, s.noise * 3.5);
        if (!s.capturing && !s.draining && !s.response && !voiced) s.noise = Math.min(0.015, s.noise * 0.98 + rms * 0.02);
        if (s.draining) {
          s.quiet = voiced ? 0 : s.quiet + seconds;
          s.collector.push(pcm, voiced);
          if (s.quiet >= 0.55) {
            s.draining = false;
            s.quiet = 0;
            s.onset = 0;
            s.collector.reset();
            pump.current(s);
          }
          refresh(s);
          return;
        }
        if (!s.capturing) {
          s.onset = voiced ? s.onset + seconds : 0;
          if (s.onset >= 0.12) {
            s.capturing = true;
            s.serial++;
            s.quiet = 0;
            stopResponse(s, false);
            opts.current.onUserUtterance?.();
          }
        } else s.quiet = voiced ? 0 : s.quiet + seconds;
        const utterance = s.collector.push(pcm, voiced);
        if (utterance) {
          s.capturing = false;
          s.onset = 0;
          s.quiet = 0;
          if (utterance.capped) {
            s.draining = true;
            utterance.chunks.forEach((chunk) => chunk.fill(0));
            setError(voiceCopy(s.locale).recordingTooLong);
          } else {
            const audio = base64Bytes(wavFromPcm(utterance.chunks, context.sampleRate, 24e3));
            utterance.chunks.forEach((chunk) => chunk.fill(0));
            enqueue(s, { audio });
          }
          pump.current(s);
        }
        refresh(s);
      };
      s.ready = true;
      setHasMicrophone(true);
      setConnected(true);
      setConnecting(false);
      refresh(s);
      s.raf = requestAnimationFrame(measure);
    } catch (e) {
      if (current(s)) {
        disconnect();
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? voiceCopy(s.locale).microphoneDenied : voiceError(s.locale, e));
      }
    }
  }, [current, disconnect, enqueue, played, refresh, stopResponse]);
  const interrupt = useCallback((hold = true) => {
    const s = session.current;
    if (s) stopResponse(s, hold && !s.capturing);
  }, [stopResponse]);
  const toggleMute = useCallback(() => {
    const s = session.current;
    if (!s?.ready) return;
    s.muted = !s.muted;
    s.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !s.muted;
    });
    s.collector?.reset();
    s.capturing = false;
    s.draining = false;
    s.onset = 0;
    s.quiet = 0;
    s.inputLevel = 0;
    s.serial++;
    invalidateObserver(s);
    if (s.muted) stopResponse(s, true);
    else {
      s.manualHold = false;
      pump.current(s);
    }
    setMuted(s.muted);
    refresh(s);
  }, [invalidateObserver, refresh, stopResponse]);
  const resetAccountContext = useCallback(() => {
    const s = session.current;
    if (!s?.ready || !current(s)) return;
    s.accountEpoch++;
    s.acknowledgements.forEach((controller) => controller.abort());
    s.acknowledgements.clear();
    s.ackBarrier = Promise.resolve();
    stopResponse(s, s.muted);
    invalidateObserver(s);
    s.collector?.reset();
    s.pending = void 0;
    s.results = [];
    s.resultIds.clear();
    s.capturing = false;
    s.draining = false;
    s.onset = 0;
    s.quiet = 0;
    s.inputLevel = 0;
    s.serial++;
    setError("");
    refresh(s);
  }, [current, invalidateObserver, refresh, stopResponse]);
  const sendText = useCallback((text) => {
    const s = session.current;
    if (!s?.ready || !current(s) || !text.trim()) return false;
    if (text.length > 4e3) {
      setError(voiceCopy(s.locale).messageTooLong);
      return false;
    }
    s.serial++;
    enqueue(s, { message: text.trim() });
    return true;
  }, [current, enqueue]);
  const getSessionOwner = useCallback(() => {
    const s = session.current;
    return s?.ready && current(s) ? s.owner : null;
  }, [current]);
  const sendTaskResult = useCallback((taskId, expectedOwner) => {
    const s = session.current;
    if (!s?.ready || !current(s) || expectedOwner !== void 0 && expectedOwner !== s.owner || !nativeIdentifier(taskId) || s.resultIds.has(taskId) || s.resultIds.size >= 64 || s.results.length >= 4) return false;
    s.resultIds.add(taskId);
    s.results.push(taskId);
    pump.current(s);
    return true;
  }, [current]);
  const setPersona = useCallback((avatar) => {
    if (["moss", "orbit", "spark"].includes(avatar)) nextAvatar.current.id = avatar;
  }, []);
  useEffect(() => {
    if (session.current && session.current.locale !== normalizeLocale(options.locale)) disconnect();
  }, [options.locale, disconnect]);
  useEffect(() => {
    if (session.current && session.current.transport.scopeKey !== (options.transport?.scopeKey ?? localNativeVoiceTransport.scopeKey)) disconnect();
  }, [options.transport?.scopeKey, disconnect]);
  useEffect(() => {
    if (session.current && (!options.backgroundAsr || options.observerPaused)) invalidateObserver(session.current);
  }, [options.backgroundAsr, options.observerPaused, invalidateObserver]);
  useEffect(() => () => disconnect(), [disconnect]);
  return { connected, connecting, hasMicrophone, phase, muted, error, audioLevel, connect, disconnect, interrupt, toggleMute, sendText, sendTaskResult, getSessionOwner, resetAccountContext, setPersona, clearError: () => setError("") };
}

// src/client/usePocketSpeech.ts
import { useCallback as useCallback2, useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
function usePocketSpeech(request) {
  const currentRequest = useRef2(request);
  currentRequest.current = request;
  const [enabled, setEnabled] = useState2(false), [speaking, setSpeaking] = useState2(false), [error, setError] = useState2("");
  const active = useRef2(null);
  const stop = useCallback2(() => {
    const old = active.current;
    active.current = null;
    old?.controller.abort();
    old?.audio?.pause();
    if (old?.url) URL.revokeObjectURL(old.url);
    setSpeaking(false);
  }, []);
  const disable = useCallback2(() => {
    stop();
    setEnabled(false);
  }, [stop]);
  const enable = useCallback2(() => {
    stop();
    setError("");
    setEnabled(true);
  }, [stop]);
  const speak = useCallback2((result) => {
    stop();
    setError("");
    const owned = { controller: new AbortController() };
    active.current = owned;
    void currentRequest.current(result, AbortSignal.any([owned.controller.signal, AbortSignal.timeout(45e3)])).then(async (response) => {
      if (active.current !== owned || owned.controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "audio/wav") {
        await response.body?.cancel();
        throw Error("Local speech unavailable.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("Local speech unavailable.");
      let bytes = 0;
      const chunks = [];
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > 44 + 24e3 * 2 * 31) throw Error("Invalid local audio.");
          chunks.push(new Uint8Array(item.value));
        }
      } finally {
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
      }
      if (active.current !== owned || owned.controller.signal.aborted) return;
      if (bytes < 46) throw Error("Invalid local audio.");
      const url = URL.createObjectURL(new Blob(chunks, { type: "audio/wav" })), audio = new Audio(url);
      owned.audio = audio;
      owned.url = url;
      audio.onended = () => {
        if (active.current === owned) stop();
      };
      audio.onerror = () => {
        if (active.current === owned) {
          stop();
          setError("Local speech could not play. Your reply remains saved.");
        }
      };
      await audio.play();
      if (active.current === owned) setSpeaking(true);
    }).catch(() => {
      if (active.current === owned) {
        stop();
        setError("Local speech unavailable. Your reply remains saved.");
      }
    });
  }, [stop]);
  useEffect2(() => () => {
    const old = active.current;
    active.current = null;
    old?.controller.abort();
    old?.audio?.pause();
    if (old?.url) URL.revokeObjectURL(old.url);
  }, []);
  return { enabled, speaking, error, enable, disable, stop, speak };
}
export {
  DEFAULT_LOCALE,
  localNativeVoiceTransport,
  normalizeLocale,
  snapshotNativeVoiceTransport,
  useNativeRouterVoice,
  usePocketSpeech,
  voiceHeaders
};
