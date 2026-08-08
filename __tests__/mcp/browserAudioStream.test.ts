import {
  openSession,
  shutdownBrowserRuntime,
  type BrowserSession,
} from '../../mcp-servers/browser/src/runtime';
import {
  ensureBrowserGateway,
  prepareBrowserAudioStream,
  shutdownBrowserGateway,
} from '../../mcp-servers/browser/src/gateway';

jest.setTimeout(30_000);

function failAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

describe('browser audio stream integration', () => {
  const savedEnv = { ...process.env };
  let session: BrowserSession | undefined;

  afterEach(async () => {
    await shutdownBrowserGateway();
    await shutdownBrowserRuntime();
    session = undefined;
    process.env = { ...savedEnv };
  });

  it('captures audio created before the client opens /audio', async () => {
    delete process.env.FLUJO_BROWSER_STREAM_ENABLED;
    delete process.env.FLUJO_BROWSER_STREAM_AUDIO;
    session = await openSession('preinstalled-audio-test', new AbortController().signal);

    // This is the ordering browser navigation now uses: install the main-world
    // hook first, then allow page code to construct its audio graph.
    await prepareBrowserAudioStream(session.id);
    const cdp = await session.context.newCDPSession(session.page);
    await cdp.send('Runtime.enable');
    const created = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.__audioTestContext = new AudioContext();
        window.__audioTestOscillator = window.__audioTestContext.createOscillator();
        window.__audioTestOscillator.frequency.value = 523.25;
        window.__audioTestOscillator.connect(window.__audioTestContext.destination);
        window.__audioTestOscillator.start();
        return {
          tapped: window.__flujoAudioTap,
          muted: window.__flujoAudioMuted,
          destination: window.__audioTestContext.destination.constructor.name
        };
      })()`,
      returnByValue: true,
    });
    expect(created.result.value).toEqual({
      tapped: true,
      muted: true,
      destination: 'GainNode',
    });

    const endpoint = await ensureBrowserGateway();
    expect(endpoint).toBeDefined();
    const abort = new AbortController();
    const response = await Promise.race([
      fetch(`${endpoint!.origin}/audio?s=${session.id}&t=${encodeURIComponent(endpoint!.token)}`, {
        signal: abort.signal,
      }),
      failAfter(8_000, 'Audio response did not start.'),
    ]);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 12) {
      const next = await Promise.race([
        reader.read(),
        failAfter(8_000, 'Audio bytes did not arrive.'),
      ]);
      expect(next.done).toBe(false);
      chunks.push(next.value!);
      size += next.value!.byteLength;
    }
    const wire = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      wire.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const header = new DataView(wire.buffer, wire.byteOffset, 12);
    expect(header.getUint32(0, true)).toBeGreaterThanOrEqual(8_000);
    expect(header.getUint32(4, true)).toBe(2);
    expect(header.getUint32(8, true)).toBeGreaterThan(0);

    await reader.cancel();
    abort.abort();
    await cdp.send('Runtime.evaluate', {
      expression: 'try{window.__audioTestOscillator.stop()}catch{};window.__audioTestContext.close()',
    });
    await cdp.detach();
  });
});
