import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import {
  ESSENTIAL_RETRY_DELAYS_MS,
  HealAfterChunkFailure,
  healRetryDelayMs,
  isChunkLoadError,
  lazyEssential,
  lazyOptional,
  optionalRetryDelayMs,
} from '@/frontend/lazy';
import { retryFailedChunks } from '@/frontend/lazy/chunks';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

function chunkLoadError(): Error {
  const error = new Error('Loading chunk 4812 failed.\n(timeout: http://localhost:4200/_next/static/chunks/4812.js)');
  error.name = 'ChunkLoadError';
  return error;
}

/** Stands in for the app's error boundary: anything that reaches it replaces the whole screen. */
class ScreenBoundary extends React.Component<
  { children: React.ReactNode; heal?: boolean },
  { failure: { error: unknown } | null }
> {
  state: { failure: { error: unknown } | null } = { failure: null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: { error } };
  }
  private healed = () => this.setState({ failure: null });
  render() {
    if (!this.state.failure) return this.props.children;
    return (
      <>
        <h1>The workspace hit a snag</h1>
        {this.props.heal && isChunkLoadError(this.state.failure.error) && <HealAfterChunkFailure onHealed={this.healed} />}
      </>
    );
  }
}

/** A loader that fails `failures` times with `error`, then loads `Piece`. */
function flakyLoader<P extends object>(Piece: React.ComponentType<P>, failures: number, error: () => unknown = chunkLoadError) {
  let calls = 0;
  const load = jest.fn(async () => {
    calls += 1;
    if (calls <= failures) throw error();
    return { default: Piece };
  });
  return load;
}

/** Renders inside an async act so React sees the loader settle. */
async function renderScreen(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function settle() {
  await advance(0);
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  // React reports every error a boundary catches; the tests assert on the screen instead.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  // Failed chunks are remembered app-wide; every loader here loads on its next try, so this leaves none behind.
  await act(async () => {
    expect((await retryFailedChunks()).stillFailing).toBe(0);
  });
  consoleError.mockRestore();
  jest.useRealTimers();
});

describe('isChunkLoadError', () => {
  it.each([
    ['a webpack script chunk', chunkLoadError()],
    ['a webpack CSS chunk', Object.assign(new Error('Loading CSS chunk 77 failed.\n(/_next/static/css/77.css)'), { code: 'CSS_CHUNK_LOAD_FAILED' })],
    ['a Turbopack chunk', new Error('Failed to load chunk /_next/static/chunks/abc.js from module 123')],
    ['a Chrome module', new TypeError('Failed to fetch dynamically imported module: http://localhost/x.js')],
    ['a Firefox module', new TypeError('error loading dynamically imported module: http://localhost/x.js')],
    ['a Safari module', new TypeError('Importing a module script failed.')],
  ])('recognises %s that did not arrive', (_case, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ['a render bug', new TypeError("Cannot read properties of undefined (reading 'map')")],
    ['a thrown string', 'Loading chunk 1 failed'],
    ['nothing', undefined],
  ])('does not mistake %s for a chunk that did not arrive', (_case, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('lazyOptional (decorations and other extras)', () => {
  it('keeps the rest of the screen working when the decoration fails to load, then loads it later by itself', async () => {
    const load = flakyLoader(() => <div data-testid="living-world">river</div>, 1);
    const Decoration = lazyOptional(load, { name: 'RiverWorld' });

    await renderScreen(
      <ScreenBoundary>
        <Decoration />
        <main>Workspace</main>
        <button type="button">New chat</button>
      </ScreenBoundary>,
    );
    await settle();

    expect(screen.queryByText('The workspace hit a snag')).not.toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled();
    expect(screen.queryByTestId('living-world')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);

    await advance(optionalRetryDelayMs(0));

    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('living-world')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.queryByText('The workspace hit a snag')).not.toBeInTheDocument();
  });

  it('keeps trying with longer waits for as long as the chunk is missing', async () => {
    const load = flakyLoader(() => <div data-testid="dock">dock</div>, 3);
    const Dock = lazyOptional(load, { name: 'AskFlujoDock' });

    await renderScreen(<ScreenBoundary><Dock /><main>Workspace</main></ScreenBoundary>);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    await advance(optionalRetryDelayMs(0));
    expect(load).toHaveBeenCalledTimes(2);
    await advance(optionalRetryDelayMs(1) - 1);
    expect(load).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(load).toHaveBeenCalledTimes(3);
    await advance(optionalRetryDelayMs(2));

    expect(load).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('dock')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(optionalRetryDelayMs(30)).toBe(120_000);
  });

  it('contains a decoration that crashes while drawing and draws it again later', async () => {
    let crash = true;
    function Canvas() {
      if (crash) throw new Error('canvas context lost');
      return <canvas data-testid="canvas" />;
    }
    const Decoration = lazyOptional(async () => ({ default: Canvas }), { name: 'RiverWorld' });

    await renderScreen(<ScreenBoundary><Decoration /><main>Workspace</main></ScreenBoundary>);
    await settle();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();

    crash = false;
    await advance(optionalRetryDelayMs(0));

    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    expect(screen.queryByText('The workspace hit a snag')).not.toBeInTheDocument();
  });

  it('shows its plain fallback while it waits', async () => {
    const Decoration = lazyOptional(flakyLoader(() => <div>loaded</div>, 1), {
      name: 'Badge',
      fallback: () => <span>badge placeholder</span>,
    });

    await renderScreen(<ScreenBoundary><Decoration /></ScreenBoundary>);
    await settle();
    expect(screen.getByText('badge placeholder')).toBeInTheDocument();

    await advance(optionalRetryDelayMs(0));
    expect(screen.getByText('loaded')).toBeInTheDocument();
  });
});

describe('lazyEssential', () => {
  it('fetches a chunk that failed once again, showing its loading state instead of the error page', async () => {
    const load = flakyLoader(({ children }: { children?: React.ReactNode }) => <nav>{children}</nav>, 1);
    const Navigation = lazyEssential(load, { name: 'Navigation', loading: () => <p>Loading navigation</p> });

    await renderScreen(<ScreenBoundary><Navigation>Home</Navigation></ScreenBoundary>);
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading navigation')).toBeInTheDocument();
    expect(screen.queryByText('The workspace hit a snag')).not.toBeInTheDocument();

    await advance(ESSENTIAL_RETRY_DELAYS_MS[0]);

    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('navigation')).toHaveTextContent('Home');
    expect(screen.queryByText('The workspace hit a snag')).not.toBeInTheDocument();
  });

  it('passes an error that is not a missing chunk straight to the error page', async () => {
    const load = flakyLoader(() => <nav />, 1, () => new SyntaxError('Unexpected token in module'));
    const Navigation = lazyEssential(load, { name: 'Navigation', loading: () => null });

    await renderScreen(<ScreenBoundary><Navigation /></ScreenBoundary>);
    await settle();

    expect(screen.getByText('The workspace hit a snag')).toBeInTheDocument();
    await advance(ESSENTIAL_RETRY_DELAYS_MS[0] * 10);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows the error page only after the retries, and the error page brings the screen back once the chunk loads', async () => {
    const retries = ESSENTIAL_RETRY_DELAYS_MS.length;
    const load = flakyLoader(() => <p>Theme ready</p>, retries + 2);
    const ThemeProvider = lazyEssential(load, { name: 'ThemeProvider', loading: () => <p>Preparing theme</p> });

    await renderScreen(<ScreenBoundary heal><ThemeProvider /></ScreenBoundary>);
    await settle();
    for (const delayMs of ESSENTIAL_RETRY_DELAYS_MS.slice(0, -1)) {
      await advance(delayMs);
      expect(screen.getByText('Preparing theme')).toBeInTheDocument();
    }
    await advance(ESSENTIAL_RETRY_DELAYS_MS[retries - 1]);

    expect(load).toHaveBeenCalledTimes(retries + 1);
    expect(screen.getByText('The workspace hit a snag')).toBeInTheDocument();

    await advance(healRetryDelayMs(0));
    expect(load).toHaveBeenCalledTimes(retries + 2);
    expect(screen.getByText('The workspace hit a snag')).toBeInTheDocument();

    await advance(healRetryDelayMs(1));

    expect(load).toHaveBeenCalledTimes(retries + 3);
    expect(screen.getByText('Theme ready')).toBeInTheDocument();
    expect(screen.queryByText('The workspace hit a snag')).not.toBeInTheDocument();
  });
});

describe('HealAfterChunkFailure for a chunk no lazy piece owns', () => {
  const savedFetch = global.fetch;
  afterEach(() => { global.fetch = savedFetch; });

  function PageChunk(): React.ReactElement {
    throw chunkLoadError();
  }

  const reloadAttempted = () => consoleError.mock.calls.some(([first]) => String(first).includes('Not implemented: navigation'));

  it('waits while the server does not answer, then reloads the page once it does', async () => {
    const fetchMock = jest.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;

    await renderScreen(<ScreenBoundary heal><PageChunk /></ScreenBoundary>);
    expect(screen.getByText('The workspace hit a snag')).toBeInTheDocument();

    await advance(healRetryDelayMs(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(window.location.href, { method: 'HEAD', cache: 'no-store' });
    expect(reloadAttempted()).toBe(false);

    await advance(healRetryDelayMs(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reloadAttempted()).toBe(true);
  });
});
