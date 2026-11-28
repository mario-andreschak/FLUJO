import { audioSinkMutedExpression, audioTapSource } from '../../mcp-servers/browser/src/audioTap';

type Processor = { onaudioprocess: ((event: unknown) => void) | null; connect: () => void };

/** Just enough of a page for the tap: one AudioContext class, a document and the listener functions. */
function fakePage() {
  const processors: Processor[] = [];
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = { maxChannelCount: 2 };
    createGain() {
      return { connect: () => undefined, maxChannelCount: 0 };
    }
    createScriptProcessor() {
      const processor: Processor = { onaudioprocess: null, connect: () => undefined };
      processors.push(processor);
      return processor;
    }
  }
  const received: Record<string, string[]> = { live: [], record: [] };
  const window: Record<string, unknown> = {
    AudioContext: FakeAudioContext,
    __live: (payload: string) => received.live.push(payload),
    __record: (payload: string) => received.record.push(payload),
  };
  const document = { addEventListener: () => undefined, querySelectorAll: () => [] };
  const btoa = (binary: string) => Buffer.from(binary, 'binary').toString('base64');
  const run = (script: string) => {
    new Function('window', 'document', 'btoa', script)(window, document, btoa);
  };
  const play = (level: number) => {
    const samples = Float32Array.of(level, -level, level, 0);
    const event = { inputBuffer: { length: samples.length, numberOfChannels: 2, getChannelData: () => samples } };
    for (const processor of processors) processor.onaudioprocess?.(event);
  };
  const newContext = () => new (window.AudioContext as new () => unknown)();
  return { window, received, run, play, newContext };
}

describe('page audio tap shared by the live view and recordings (#1390)', () => {
  it('delivers sound to every listener that is switched on, and only to those', () => {
    const page = fakePage();
    page.run(audioTapSource('__live', true));
    page.newContext();
    page.run(audioTapSource('__record', false));

    page.play(0.5);
    expect(page.received.record).toHaveLength(1);
    expect(page.received.live).toHaveLength(0);
    expect(JSON.parse(page.received.record[0])).toMatchObject({ rate: 48_000, pcm: expect.any(String) });

    page.run(audioSinkMutedExpression('__live', false));
    page.play(0.5);
    expect(page.received.live).toHaveLength(1);
    expect(page.received.record).toHaveLength(2);

    page.run(audioSinkMutedExpression('__record', true));
    page.play(0.5);
    expect(page.received.live).toHaveLength(2);
    expect(page.received.record).toHaveLength(2);
  });

  it('never switches off a listening recording when the live view installs its hook later', () => {
    const page = fakePage();
    page.run(audioTapSource('__record', false));
    page.newContext();
    page.run(audioTapSource('__live', true));

    page.play(0.5);
    expect(page.received.record).toHaveLength(1);
    expect(page.received.live).toHaveLength(0);
  });

  it('sends nothing for silence or when no listener is on', () => {
    const page = fakePage();
    page.run(audioTapSource('__record', false));
    page.newContext();
    page.play(0);
    expect(page.received.record).toHaveLength(0);

    page.run(audioSinkMutedExpression('__record', true));
    page.play(0.5);
    expect(page.received.record).toHaveLength(0);
  });

  it('switches off only a listener that fails, so the other keeps hearing the page', () => {
    const page = fakePage();
    page.run(audioTapSource('__live', false));
    page.run(audioTapSource('__record', false));
    page.newContext();
    page.window.__live = () => { throw new Error('binding gone'); };

    page.play(0.5);
    page.play(0.5);
    expect(page.received.record).toHaveLength(2);
    expect((page.window.__flujoAudioSinks as Record<string, boolean>).__live).toBe(true);
  });
});
