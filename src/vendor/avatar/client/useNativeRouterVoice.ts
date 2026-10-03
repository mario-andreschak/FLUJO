import { useCallback, useEffect, useRef, useState } from 'react';
import { base64Bytes, wavFromPcm } from './audio';
import type { AvatarId, Phase } from './domain';
import { normalizeLocale, type Locale } from './locale';
import { voiceCopy, voiceError, VoiceLocaleError, voiceRequestError, voiceResponseError } from './voiceLocale';
import { UtteranceCollector } from './utteranceObserver';
import { nativeAbortable, nativeAudioBytes, nativeIdentifier, NativeRouterPlayback, readNativeTurn } from './nativeRouterPlayback';
import type { NativePlayed, NativeTurnEvent } from './nativeRouterPlayback';
import { localNativeVoiceTransport, snapshotNativeVoiceTransport, resetNativeHistory, voiceHeaders } from './nativeVoiceTransport';
import type { AvatarVoiceEndpoint, NativeVoiceTransport } from './nativeVoiceTransport';
export { voiceHeaders } from './nativeVoiceTransport';
export type { NativeVoiceTransport } from './nativeVoiceTransport';

interface Options {
  avatar: AvatarId;
  locale?: Locale;
  onTranscript: (id: string, role: 'user' | 'assistant', text: string, done: boolean) => void;
  onUserUtterance?: () => void;
  backgroundAsr?: boolean;
  /** Work recordings go straight to recognition and the host work lane, without a second spoken acknowledgement. */
  workInput?: boolean;
  observerPaused?: boolean;
  onObservedTranscript?: (id: string, text: string) => void;
  onObserverError?: () => void;
  onInterrupted?: () => void;
  /** An authenticated host may replace URLs/headers without changing audio or work ownership. */
  transport?: NativeVoiceTransport;
}
type Input = { generation: number; serial: number; avatar: AvatarId; message?: string; audio?: string; taskId?: string; workInput?: boolean };
interface Observation { turnId: string; audio: string; serial: number; }
interface Turn { generation: number; abort: AbortController; turnId?: string; complete?: Extract<NativeTurnEvent, { type: 'complete' }>; }
interface Session {
  transport: NativeVoiceTransport;
  owner: symbol; accountEpoch: number; abort: AbortController; locale: Locale; ready: boolean; muted: boolean;
  context?: AudioContext; input?: MediaStreamAudioSourceNode; stream?: MediaStream;
  capture?: AudioWorkletNode; silent?: GainNode; playback?: NativeRouterPlayback; raf?: number;
  collector?: UtteranceCollector; noise: number; onset: number; quiet: number; capturing: boolean; draining: boolean; inputLevel: number;
  generation: number; serial: number; response?: Turn; pumping: boolean; pending?: Input; manualHold: boolean;
  results: string[]; resultIds: Set<string>;
  observerEpoch: number; observer?: AbortController; observation?: Observation;
  ackBarrier: Promise<void>; acknowledgements: Set<AbortController>;
}

const cancelled = () => new DOMException('The native voice turn was cancelled.', 'AbortError');

/** Native complete-utterance audio in / PCM out. This HTTP transport is not a Live duplex socket. */
export function useNativeRouterVoice(options: Options) {
  const opts = useRef(options); opts.current = options;
  const nextAvatar = useRef({ id: options.avatar, prop: options.avatar });
  if (nextAvatar.current.prop !== options.avatar) nextAvatar.current = { id: options.avatar, prop: options.avatar };
  const session = useRef<Session | null>(null);
  const [connected, setConnected] = useState(false), [connecting, setConnecting] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle'), [muted, setMuted] = useState(false);
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0), [error, setError] = useState('');
  const pump = useRef<(s: Session) => void>(() => {}), observe = useRef<(s: Session, item: Observation) => void>(() => {});
  const fail = useRef<(s: Session) => void>(() => {});
  const current = useCallback((s: Session) => session.current === s && !s.abort.signal.aborted
    && s.transport.scopeKey === (opts.current.transport?.scopeKey ?? localNativeVoiceTransport.scopeKey), []);
  const liveTurn = useCallback((s: Session, t: Turn) => current(s) && s.response === t && s.generation === t.generation && !t.abort.signal.aborted, [current]);
  const refresh = useCallback((s: Session) => {
    if (!current(s) || !s.ready) return;
    const responding = s.response && !s.response.abort.signal.aborted && s.generation === s.response.generation;
    setPhase(s.capturing ? 'listening' : responding ? s.playback?.queuedSamples ? 'speaking' : 'thinking' : s.muted || !s.stream ? 'idle' : 'listening');
  }, [current]);
  const invalidateObserver = useCallback((s: Session) => {
    s.observerEpoch++; s.observer?.abort(); s.observer = undefined; s.observation = undefined;
  }, []);
  const stopResponse = useCallback((s: Session, hold: boolean, dropPending = true) => {
    s.generation++; s.manualHold = hold; if (dropPending) { s.pending = undefined; s.results = []; }
    const turn = s.response; turn?.abort.abort();
    if (turn?.turnId) s.playback?.cancel(turn.turnId);
    setAudioLevel(0); if (current(s)) { opts.current.onInterrupted?.(); setPhase(s.muted ? 'idle' : 'listening'); }
  }, [current]);
  const disconnect = useCallback(() => {
    const old = session.current; session.current = null;
    if (old) {
      opts.current.onInterrupted?.();
      old.abort.abort(); old.response?.abort.abort(); invalidateObserver(old);
      old.acknowledgements.forEach(controller => controller.abort()); old.acknowledgements.clear();
      old.pending = undefined; old.results = []; old.resultIds.clear(); old.collector?.reset();
      if (old.raf !== undefined) cancelAnimationFrame(old.raf);
      if (old.capture) { old.capture.port.onmessage = null; old.capture.disconnect(); }
      old.input?.disconnect(); old.silent?.disconnect(); old.stream?.getTracks().forEach(track => track.stop());
      void old.context?.close().catch(() => {}); void old.playback?.close().catch(() => {});
    }
    // Reconnect resets server history before first input; no late disconnect reset can erase a new session.
    setConnected(false); setHasMicrophone(false); setConnecting(false); setMuted(false); setPhase('idle'); setAudioLevel(0);
  }, [invalidateObserver]);
  fail.current = s => { if (current(s)) { disconnect(); setError(voiceCopy(s.locale).streamFailed); } };

  const request = useCallback(async (s: Session, path: AvatarVoiceEndpoint, body: object, signal: AbortSignal, timeout = 45_000) => {
    if (!current(s)) throw cancelled();
    const response = await s.transport.request(path, { method: 'POST', headers: voiceHeaders(),
      body: JSON.stringify({ ...body, locale: s.locale }), signal: AbortSignal.any([signal, s.abort.signal, AbortSignal.timeout(timeout)]) });
    if (!current(s)) { await response.body?.cancel(); throw cancelled(); }
    if (!response.ok) {
      const error = await voiceResponseError(response);
      if ((response.status === 401 || response.status === 403) && current(s)) {
        disconnect(); setError(voiceError(s.locale, error));
      }
      throw error;
    }
    return response;
  }, [current, disconnect]);
  const played = useCallback((s: Session, receipt: NativePlayed) => {
    if (!current(s)) return;
    const accountEpoch = s.accountEpoch;
    const publish = async () => {
      if (!current(s) || accountEpoch !== s.accountEpoch) return;
      const controller = new AbortController(); s.acknowledgements.add(controller);
      try {
        const response = await request(s, 'native-played', receipt, controller.signal, 5000);
        await response.body?.cancel();
      } finally { s.acknowledgements.delete(controller); }
    };
    if (receipt.complete) {
      // The next request must see the prior fully heard response in server history.
      s.ackBarrier = s.ackBarrier.then(publish);
      void s.ackBarrier.catch(() => { if (current(s) && accountEpoch === s.accountEpoch) fail.current(s); });
    } else void publish().catch(() => {}); // A cancelled reply adds no heard assistant history.
  }, [current, request]);

  observe.current = (s, item) => {
    if (!current(s) || s.muted || !opts.current.backgroundAsr || opts.current.observerPaused) return;
    if (s.observer) { s.observation = item; return; }
    const controller = new AbortController(), epoch = s.observerEpoch; s.observer = controller;
    void request(s, 'native-observe', { audio: item.audio, format: 'wav', turnId: item.turnId }, controller.signal)
      .then(response => response.json()).then((body: unknown) => {
        if (!body || typeof body !== 'object' || !('text' in body) || typeof body.text !== 'string' || body.text.length > 8000) throw new VoiceLocaleError('speechUnrecognized');
        if (!current(s) || controller.signal.aborted || epoch !== s.observerEpoch || item.serial !== s.serial || s.muted || opts.current.observerPaused) return;
        const text = body.text.trim(); if (!text) return;
        const id = `native-observed-${item.turnId}`;
        if (opts.current.onObservedTranscript) opts.current.onObservedTranscript(id, text);
        else opts.current.onTranscript(id, 'user', text, true);
      }).catch(() => {
        if (current(s) && !controller.signal.aborted && epoch === s.observerEpoch && item.serial === s.serial && !s.muted && !opts.current.observerPaused) opts.current.onObserverError?.();
      }).finally(() => {
        if (s.observer !== controller) return;
        s.observer = undefined; const next = s.observation; s.observation = undefined;
        if (next) observe.current(s, next);
      });
  };

  const process = useCallback(async (s: Session, input: Input) => {
    const turn: Turn = { generation: input.generation, abort: new AbortController() }; s.response = turn;
    // One deadline covers network generation, queue backpressure and hardware drain.
    const deadline = setTimeout(() => turn.abort.abort(), 45_000);
    refresh(s);
    try {
      await nativeAbortable(s.ackBarrier, turn.abort.signal);
      if (!liveTurn(s, turn)) throw cancelled();
      if (input.audio && input.workInput) {
        const response = await request(s, 'native-input', { audio: input.audio, format: 'wav', avatar: input.avatar }, turn.abort.signal);
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('text' in body) || typeof body.text !== 'string' || body.text.length > 4000) throw new VoiceLocaleError('speechUnrecognized');
        if (!liveTurn(s, turn) || input.serial !== s.serial || s.muted || opts.current.observerPaused) return;
        const text = body.text.trim();
        if (text) {
          const id = crypto.randomUUID();
          if (opts.current.onObservedTranscript) opts.current.onObservedTranscript(id, text);
          else opts.current.onTranscript(id, 'user', text, true);
        }
        return;
      }
      if (input.message) opts.current.onTranscript(crypto.randomUUID(), 'user', input.message, true);
      const path = input.taskId ? 'native-result' : 'native-turn';
      const payload = input.taskId ? { taskId: input.taskId, avatar: input.avatar }
        : input.audio ? { audio: input.audio, format: 'wav', avatar: input.avatar } : { message: input.message, avatar: input.avatar };
      const response = await request(s, path, payload, turn.abort.signal);
      if (!liveTurn(s, turn)) { await response.body?.cancel(); throw cancelled(); }
      await readNativeTurn(response, AbortSignal.any([turn.abort.signal, s.abort.signal]), async event => {
        if (!liveTurn(s, turn)) throw cancelled();
        if (event.type === 'start') {
          turn.turnId = event.turnId;
          if (!s.playback?.begin(event.turnId)) throw new VoiceLocaleError('unsupportedAudio');
          if (input.audio) observe.current(s, { turnId: event.turnId, audio: input.audio, serial: input.serial });
        } else if (event.type === 'audio') {
          await s.playback!.enqueue(event.turnId, nativeAudioBytes(event.data), turn.abort.signal);
          if (liveTurn(s, turn)) refresh(s);
        } else if (event.type === 'caption') {
          opts.current.onTranscript(`native-${event.turnId}`, 'assistant', event.text, false);
        } else if (event.type === 'complete') turn.complete = event;
        else throw voiceRequestError(502, event.code);
      });
      // EOF is validated before sealing the output ledger. Extra data cannot gain a full-played receipt.
      if (!turn.complete || !turn.turnId || !liveTurn(s, turn)) throw new VoiceLocaleError('streamFailed');
      await s.playback!.drain(turn.turnId, turn.complete.samples, turn.abort.signal);
      await nativeAbortable(s.ackBarrier, turn.abort.signal);
      if (liveTurn(s, turn)) opts.current.onTranscript(`native-${turn.turnId}`, 'assistant', turn.complete.text, true);
    } catch (e) {
      if (turn.turnId) s.playback?.cancel(turn.turnId);
      if (current(s) && s.response === turn && s.generation === turn.generation) {
        opts.current.onInterrupted?.(); setError(voiceError(s.locale, e, 'streamFailed'));
      }
    } finally {
      clearTimeout(deadline);
      if (s.response === turn) s.response = undefined;
      if (current(s)) { refresh(s); pump.current(s); }
    }
  }, [current, liveTurn, refresh, request]);
  pump.current = s => {
    if (!current(s) || !s.ready || s.pumping || s.capturing || s.draining) return;
    const pending = s.pending;
    if ((s.muted && pending?.message === undefined) || s.manualHold) return;
    let input = pending;
    if (!input && !s.muted && s.results.length) input = { taskId: s.results.shift()!, generation: s.generation, serial: s.serial, avatar: nextAvatar.current.id };
    if (!input) return;
    s.pending = undefined; s.pumping = true;
    void process(s, input).finally(() => { s.pumping = false; if (current(s)) pump.current(s); });
  };
  const enqueue = useCallback((s: Session, value: { audio: string } | { message: string }) => {
    stopResponse(s, false);
    s.pending = { ...value, workInput: Boolean(opts.current.workInput), avatar: nextAvatar.current.id, generation: s.generation, serial: s.serial };
    pump.current(s);
  }, [stopResponse]);

  const connect = useCallback(async (withMicrophone = true) => {
    if (session.current) { if (current(session.current) && (!withMicrophone || session.current.stream)) return; disconnect(); }
    setConnecting(true); setError('');
    let transport: NativeVoiceTransport;
    try { transport = snapshotNativeVoiceTransport(opts.current.transport); }
    catch { setConnecting(false); setError(voiceCopy(normalizeLocale(opts.current.locale)).streamFailed); return; }
    const s: Session = { transport, owner: Symbol('native-voice-session'), accountEpoch: 0, abort: new AbortController(), locale: normalizeLocale(opts.current.locale), ready: false, muted: false,
      noise: .002, onset: 0, quiet: 0, capturing: false, draining: false, inputLevel: 0, generation: 0, serial: 0, pumping: false, manualHold: false,
      results: [], resultIds: new Set(), observerEpoch: 0, ackBarrier: Promise.resolve(), acknowledgements: new Set() };
    session.current = s;
    try {
      await resetNativeHistory(s.transport, s.abort.signal); if (!current(s)) return;
      if (withMicrophone && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)) throw new VoiceLocaleError('browserRequired');
      const context = new AudioContext(); s.context = context; await context.resume(); if (!current(s)) return;
      s.playback = new NativeRouterPlayback({ onPlayed: receipt => played(s, receipt), onError: () => fail.current(s) });
      if (!await s.playback.resume() || !current(s)) throw new VoiceLocaleError('playbackBlocked');
      const meter = new Float32Array(s.playback.analyser.fftSize); let last = 0;
      const measure = (now: number) => {
        if (!current(s)) return;
        if (now - last >= 50) {
          last = now;
          if (s.playback!.queuedSamples && !s.capturing) {
            s.playback!.analyser.getFloatTimeDomainData(meter); let power = 0; for (const sample of meter) power += sample * sample;
            setAudioLevel(Math.min(1, Math.sqrt(power / meter.length) * 5));
          } else setAudioLevel(s.muted ? 0 : s.inputLevel);
          refresh(s);
        }
        s.raf = requestAnimationFrame(measure);
      };
      if (!withMicrophone) { s.ready = true; setConnected(true); setConnecting(false); setPhase('idle'); s.raf = requestAnimationFrame(measure); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current(s)) { stream.getTracks().forEach(track => track.stop()); return; }
      s.stream = stream;
      await context.audioWorklet.addModule(s.transport.workletUrl); if (!current(s)) return;
      const capture = new AudioWorkletNode(context, 'voice-capture'); s.capture = capture;
      s.silent = context.createGain(); s.silent.gain.value = 0; s.input = context.createMediaStreamSource(stream);
      s.input.connect(capture).connect(s.silent).connect(context.destination); s.collector = new UtteranceCollector(context.sampleRate, 25);
      capture.port.onmessage = event => {
        if (!current(s) || s.muted) return;
        const pcm = event.data as Float32Array;
        if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > context.sampleRate) return;
        let power = 0; for (const sample of pcm) power += sample * sample;
        const rms = Math.sqrt(power / pcm.length), seconds = pcm.length / context.sampleRate;
        s.inputLevel = Math.min(1, rms * 5);
        const voiced = rms > Math.max(.012, s.noise * 3.5);
        // Sustained speech, including a capped utterance's tail, is not noise.
        if (!s.capturing && !s.draining && !s.response && !voiced) s.noise = Math.min(.015, s.noise * .98 + rms * .02);
        if (s.draining) {
          // A capped utterance cannot immediately restart on its remaining speech.
          s.quiet = voiced ? 0 : s.quiet + seconds;
          s.collector!.push(pcm, voiced);
          if (s.quiet >= .55) { s.draining = false; s.quiet = 0; s.onset = 0; s.collector!.reset(); pump.current(s); }
          refresh(s); return;
        }
        if (!s.capturing) {
          s.onset = voiced ? s.onset + seconds : 0;
          if (s.onset >= .12) { s.capturing = true; s.serial++; s.quiet = 0; stopResponse(s, false); opts.current.onUserUtterance?.(); }
        } else s.quiet = voiced ? 0 : s.quiet + seconds;
        const utterance = s.collector!.push(pcm, voiced);
        if (utterance) {
          s.capturing = false; s.onset = 0; s.quiet = 0;
          if (utterance.capped) { s.draining = true; utterance.chunks.forEach(chunk => chunk.fill(0)); setError(voiceCopy(s.locale).recordingTooLong); }
          else {
            const audio = base64Bytes(wavFromPcm(utterance.chunks, context.sampleRate, 24000));
            utterance.chunks.forEach(chunk => chunk.fill(0)); enqueue(s, { audio });
          }
          pump.current(s);
        }
        refresh(s);
      };
      s.ready = true; setHasMicrophone(true); setConnected(true); setConnecting(false); refresh(s);
      s.raf = requestAnimationFrame(measure);
    } catch (e) {
      if (current(s)) { disconnect(); setError(e instanceof DOMException && e.name === 'NotAllowedError' ? voiceCopy(s.locale).microphoneDenied : voiceError(s.locale, e)); }
    }
  }, [current, disconnect, enqueue, played, refresh, stopResponse]);
  const interrupt = useCallback((hold = true) => { const s = session.current; if (s) stopResponse(s, hold && !s.capturing); }, [stopResponse]);
  const toggleMute = useCallback(() => {
    const s = session.current; if (!s?.ready) return;
    s.muted = !s.muted; s.stream?.getAudioTracks().forEach(track => { track.enabled = !s.muted; });
    s.collector?.reset(); s.capturing = false; s.draining = false; s.onset = 0; s.quiet = 0; s.inputLevel = 0; s.serial++;
    invalidateObserver(s); if (s.muted) stopResponse(s, true); else { s.manualHold = false; pump.current(s); }
    setMuted(s.muted); refresh(s);
  }, [invalidateObserver, refresh, stopResponse]);
  const resetAccountContext = useCallback(() => {
    const s = session.current; if (!s?.ready || !current(s)) return;
    // First sign-in binds a new server ledger. Its old ACK rejection belongs only
    // to the explicitly discarded account scope, while microphone ownership stays.
    s.accountEpoch++;
    s.acknowledgements.forEach(controller => controller.abort()); s.acknowledgements.clear();
    s.ackBarrier = Promise.resolve();
    stopResponse(s, s.muted); invalidateObserver(s);
    s.collector?.reset(); s.pending = undefined; s.results = []; s.resultIds.clear();
    s.capturing = false; s.draining = false; s.onset = 0; s.quiet = 0; s.inputLevel = 0; s.serial++;
    setError(''); refresh(s);
  }, [current, invalidateObserver, refresh, stopResponse]);
  const sendText = useCallback((text: string) => {
    const s = session.current; if (!s?.ready || !current(s) || !text.trim()) return false;
    if (text.length > 4000) { setError(voiceCopy(s.locale).messageTooLong); return false; }
    s.serial++; enqueue(s, { message: text.trim() }); return true;
  }, [current, enqueue]);
  const getSessionOwner = useCallback((): symbol | null => {
    const s = session.current; return s?.ready && current(s) ? s.owner : null;
  }, [current]);
  const sendTaskResult = useCallback((taskId: string, expectedOwner?: symbol) => {
    const s = session.current;
    if (!s?.ready || !current(s) || expectedOwner !== undefined && expectedOwner !== s.owner ||
      !nativeIdentifier(taskId) || s.resultIds.has(taskId) || s.resultIds.size >= 64 || s.results.length >= 4) return false;
    s.resultIds.add(taskId); s.results.push(taskId); pump.current(s); return true;
  }, [current]);
  const setPersona = useCallback((avatar: AvatarId) => { if (['moss', 'orbit', 'spark'].includes(avatar)) nextAvatar.current.id = avatar; }, []);
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
  return { connected, connecting, hasMicrophone, phase, muted, error, audioLevel, connect, disconnect, interrupt, toggleMute, sendText, sendTaskResult, getSessionOwner, resetAccountContext, setPersona, clearError: () => setError('') };
}
