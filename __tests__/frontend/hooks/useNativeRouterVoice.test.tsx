import { act, renderHook, waitFor } from '@testing-library/react';
import { useNativeRouterVoice } from '@/vendor/avatar/client/useNativeRouterVoice';
import { NativeRouterPlayback } from '@/vendor/avatar/client/nativeRouterPlayback';

jest.mock('@/vendor/avatar/client/nativeRouterPlayback', () => {
  const actual = jest.requireActual('@/vendor/avatar/client/nativeRouterPlayback');
  return { ...actual, NativeRouterPlayback: jest.fn(() => ({
    queuedSamples: 0,
    analyser: { fftSize: 32, getFloatTimeDomainData: jest.fn((data: Float32Array) => data.fill(.1)) },
    resume: async () => true,
    close: async () => {},
    cancel: jest.fn(),
  })) };
});

class AudioNode {
  gain = { value: 0 };
  port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
  connect() { return this; }
  disconnect() {}
}
class AudioContextStub {
  sampleRate = 24000;
  destination = new AudioNode();
  audioWorklet = { addModule: async () => {} };
  resume = async () => {};
  close = async () => {};
  createGain = () => new AudioNode();
  createMediaStreamSource = () => new AudioNode();
}

describe('spoken work handoff', () => {
  let capture: AudioNode;
  let fetchMock: jest.Mock;
  let animation: FrameRequestCallback;
  const restore: Array<() => void> = [];
  const replace = (owner: object, key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(owner, key);
    Object.defineProperty(owner, key, { configurable: true, writable: true, value });
    restore.push(() => { if (previous) Object.defineProperty(owner, key, previous); else Reflect.deleteProperty(owner, key); });
  };
  const recording = () => {
    for (let i = 0; i < 3; i++) capture.port.onmessage?.({ data: new Float32Array(4800).fill(.08) });
    for (let i = 0; i < 5; i++) capture.port.onmessage?.({ data: new Float32Array(4800) });
  };
  const response = (text: string) => ({ ok: true, json: async () => ({ text }), body: { cancel: async () => {} } });
  beforeEach(() => {
    window.sessionStorage.clear();
    replace(globalThis, 'AudioContext', AudioContextStub);
    replace(globalThis, 'AudioWorkletNode', jest.fn(() => { capture = new AudioNode(); return capture; }));
    replace(navigator, 'mediaDevices', { getUserMedia: async () => ({ getTracks: () => [{ stop: jest.fn() }], getAudioTracks: () => [] }) });
    replace(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => { animation = callback; return 1; });
    replace(window, 'cancelAnimationFrame', () => {});
    if (!AbortSignal.any) replace(AbortSignal, 'any', (signals: AbortSignal[]) => {
      const controller = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      return controller.signal;
    });
    if (!AbortSignal.timeout) replace(AbortSignal, 'timeout', () => new AbortController().signal);
    fetchMock = jest.fn(async () => response('Make a flow.'));
    replace(globalThis, 'fetch', fetchMock);
  });
  afterEach(() => { restore.splice(0).reverse().forEach(reset => reset()); });

  it('delivers recognized work once without generating an extra avatar acknowledgement', async () => {
    const observed = jest.fn(), transcript = jest.fn();
    const { result, unmount } = renderHook(() => useNativeRouterVoice({ avatar: 'moss', locale: 'en', workInput: true, backgroundAsr: true, onTranscript: transcript, onObservedTranscript: observed }));
    await act(() => result.current.connect(true));
    act(recording);
    await waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
    expect(observed.mock.calls[0][1]).toBe('Make a flow.');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/avatar/native-reset', '/api/avatar/native-input']);
    expect(transcript).not.toHaveBeenCalled();
    unmount();
  });

  it('discards a late recognition and queued old narration when the user speaks again', async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementation(async (url: string) => url.endsWith('native-input') ? response('Newest request.') : response(''));
    fetchMock.mockImplementationOnce(async () => response(''));
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const observed = jest.fn();
    const { result, unmount } = renderHook(() => useNativeRouterVoice({ avatar: 'moss', locale: 'en', workInput: true, onTranscript: jest.fn(), onObservedTranscript: observed }));
    await act(() => result.current.connect(true));
    act(recording);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => { result.current.sendTaskResult('old-result', result.current.getSessionOwner()!); recording(); });
    await act(async () => { release(response('Obsolete request.')); });
    await waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
    expect(observed.mock.calls[0][1]).toBe('Newest request.');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('native-result'))).toBe(false);
    unmount();
  });
  it('measures real output loudness for animation even without microphone capture', async () => {
    const { result, unmount } = renderHook(() => useNativeRouterVoice({ avatar: 'moss', locale: 'en', onTranscript: jest.fn() }));
    await act(() => result.current.connect(false));
    expect(result.current.hasMicrophone).toBe(false);
    const playback = jest.mocked(NativeRouterPlayback).mock.results.at(-1)!.value as { queuedSamples: number };
    playback.queuedSamples = 24;
    act(() => animation(100));
    expect(result.current.audioLevel).toBeCloseTo(.5);
    unmount();
  });
  it('a typed work interruption still allows the next work result to be narrated', async () => {
    const { result, unmount } = renderHook(() => useNativeRouterVoice({ avatar: 'moss', locale: 'en', onTranscript: jest.fn() }));
    await act(() => result.current.connect(false));
    act(() => {
      result.current.interrupt(false);
      result.current.sendTaskResult('new-work-result', result.current.getSessionOwner()!);
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('native-result'))).toBe(true));
    unmount();
  });
});
