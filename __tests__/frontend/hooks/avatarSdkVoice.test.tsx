import { act, renderHook, waitFor } from '@testing-library/react';
import { useNativeRouterVoice, type NativeVoiceTransport } from '@flujo-ai/avatar-sdk/native-voice';

it('the installed SDK starts only on demand and closes playback when host scope changes', async () => {
  const close = jest.fn(async () => {});
  class Context {
    currentTime = 0;
    sampleRate = 24000;
    destination = {};
    createAnalyser = () => ({ connect() {}, disconnect() {}, fftSize: 32, getFloatTimeDomainData(data: Float32Array) { data.fill(0); } });
    resume = async () => {};
    close = close;
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  const raf = jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  const cancel = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const request = jest.fn(async () => ({ ok: true, body: { cancel: async () => {} } }) as Response);
  const transport: NativeVoiceTransport = { scopeKey: 'host-session-one', workletUrl: '/existing-capture.js', request };
  const onTranscript = jest.fn();
  const { result, rerender, unmount } = renderHook(({ owner }) => useNativeRouterVoice({ avatar: 'moss', transport: owner, onTranscript }), { initialProps: { owner: transport } });
  try {
    expect(request).not.toHaveBeenCalled();
    await act(() => result.current.connect(false));
    expect(result.current.error).toBe('');
    expect(result.current.connected).toBe(true);
    expect(result.current.hasMicrophone).toBe(false);
    expect(request).toHaveBeenCalledWith('native-reset', expect.objectContaining({ method: 'POST', body: '{}' }));
    rerender({ owner: { ...transport, scopeKey: 'host-session-two' } });
    await waitFor(() => expect(result.current.connected).toBe(false));
    // Capture and output own separate contexts; both must be released.
    expect(close).toHaveBeenCalledTimes(2);
    expect(onTranscript).not.toHaveBeenCalled();
  } finally {
    unmount(); raf.mockRestore(); cancel.mockRestore();
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
