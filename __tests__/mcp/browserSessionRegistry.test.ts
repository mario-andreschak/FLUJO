import {
  BrowserMcpError,
  closeSession,
  getSession,
  listSessions,
  openSession,
  shutdownBrowserRuntime,
} from '../../mcp-servers/browser/src/runtime';

const mockLaunchBrowser = jest.fn();
jest.mock('patchright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunchBrowser(...args),
    launchPersistentContext: jest.fn(),
  },
}));

function browserFixture() {
  let pageClosed = false;
  const page = {
    close: jest.fn(async () => { pageClosed = true; }),
    isClosed: jest.fn(() => pageClosed),
    mainFrame: jest.fn(() => ({})),
    on: jest.fn(),
    url: jest.fn(() => 'about:blank'),
  };
  const context = {
    close: jest.fn(async () => { pageClosed = true; }),
    newPage: jest.fn(async () => page),
    route: jest.fn(async () => undefined),
  };
  return { page, context, setClosed: (value: boolean) => { pageClosed = value; } };
}

describe('browser session registry ownership and capacity', () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    await shutdownBrowserRuntime();
    mockLaunchBrowser.mockReset();
    process.env = { ...savedEnv };
  });

  it('isolates lookup, listing, and close by authoritative owner scope', async () => {
    const fixture = browserFixture();
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => fixture.context),
      once: jest.fn(),
    });

    await openSession('owned-session', new AbortController().signal, 'run:owner-a');

    expect((listSessions('run:owner-a').sessions as Array<{ sessionId: string }>))
      .toEqual([expect.objectContaining({ sessionId: 'owned-session' })]);
    expect(listSessions('run:owner-b').sessions).toEqual([]);
    expect(() => getSession('owned-session', 'run:owner-b')).toThrow(BrowserMcpError);
    await expect(closeSession('owned-session', 'run:owner-b')).resolves.toBe(false);
    await expect(closeSession('owned-session', 'run:owner-a')).resolves.toBe(true);
  });

  it('reserves capacity before asynchronous browser creation and reclaims dead pages synchronously', async () => {
    process.env.FLUJO_BROWSER_MAX_SESSIONS = '1';
    const first = browserFixture();
    const second = browserFixture();
    const contexts = [first.context, second.context];
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => contexts.shift()),
      once: jest.fn(),
    });

    const opening = openSession('first', new AbortController().signal, 'run:owner-a');
    await expect(openSession('racing', new AbortController().signal, 'run:owner-a'))
      .rejects.toMatchObject({ code: 'SESSION_LIMIT' });
    await opening;

    first.setClosed(true);
    await expect(openSession('replacement', new AbortController().signal, 'run:owner-a'))
      .resolves.toMatchObject({ id: 'replacement' });
  });
});
