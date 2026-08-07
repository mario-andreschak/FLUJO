import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_MAX_REDIRECTS = 10;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type BrowserErrorCode =
  | 'BROWSER_UNAVAILABLE'
  | 'CANCELLED'
  | 'INVALID_ARGUMENT'
  | 'NAVIGATION_BLOCKED'
  | 'NOT_FOUND'
  | 'SESSION_LIMIT'
  | 'TIMEOUT'
  | 'UNEXPECTED';

export class BrowserMcpError extends Error {
  constructor(public readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = 'BrowserMcpError';
  }
}

export type BrowserSession = {
  id: string;
  context: BrowserContext;
  page: Page;
  touchedAt: number;
  documentRequests: number;
  navigationBlocked: boolean;
};

let browser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;
let runtimeRoot: string | undefined;
let lastSessionId: string | undefined;
const sessions = new Map<string, BrowserSession>();

export function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

export function enabledEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '');
}

/** Viewport the live view starts at before the app reports its real size. */
export function defaultViewport(): { width: number; height: number } {
  return {
    width: integerEnv('FLUJO_BROWSER_VIEWPORT_WIDTH', 1280, 320, 3840),
    height: integerEnv('FLUJO_BROWSER_VIEWPORT_HEIGHT', 720, 240, 2160),
  };
}

export function timeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'timeoutMs must be a finite number.');
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(value)));
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const entry of (process.env.FLUJO_BROWSER_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === trimmed.replace(/\/$/, '')) {
        origins.add(url.origin);
      }
    } catch {
      // Invalid policy entries never widen access.
    }
  }
  return origins;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (isIP(normalized) !== 4) return false;
  const parts = normalized.split('.').map(Number);
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

const DNS_CACHE_TTL_MS = 60_000;
const DNS_CACHE_MAX_ENTRIES = 512;
const dnsCache = new Map<string, { expiresAt: number; addresses: string[] }>();

/**
 * Resolve a hostname for the SSRF check, memoised for a minute.
 *
 * Every subresource passes through the route handler, so an uncached lookup per
 * request meant a media-heavy page (an HLS player fetching one segment per few
 * seconds, or any CDN-backed site) paid a DNS round trip per asset and stalled.
 */
async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > now) return cached.addresses;
  const addresses = (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  if (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) dnsCache.clear();
  dnsCache.set(hostname, { expiresAt: now + DNS_CACHE_TTL_MS, addresses });
  return addresses;
}

export async function assertNavigationAllowed(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The URL is malformed.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'Only HTTP and HTTPS URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'URLs containing credentials are not allowed.');
  }

  const configuredOrigins = allowedOrigins();
  if (configuredOrigins.size > 0 && !configuredOrigins.has(url.origin)) {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The URL origin is not allowed by browser policy.');
  }

  if (!enabledEnv('FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS')) {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new BrowserMcpError('NAVIGATION_BLOCKED', 'Private and local network destinations are blocked.');
    }
    try {
      const addresses = isIP(hostname) ? [hostname] : await resolveHostAddresses(hostname);
      if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address))) {
        throw new BrowserMcpError('NAVIGATION_BLOCKED', 'Private and local network destinations are blocked.');
      }
    } catch (error) {
      if (error instanceof BrowserMcpError) throw error;
      throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The destination hostname could not be resolved safely.');
    }
  }
  return url;
}

async function ensureRuntimeRoot(): Promise<string> {
  if (!runtimeRoot) runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-'));
  return runtimeRoot;
}

function screenshotRoot(): string {
  const configured = process.env.FLUJO_BROWSER_SCREENSHOT_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dataRoot = process.env.FLUJO_DATA_DIR?.trim() || process.cwd();
  return path.resolve(dataRoot, 'screenshots', 'browser');
}

/** Persist the latest screenshot and return the absolute host path reported to MCP clients. */
export async function writeScreenshotArtifact(
  sessionId: string,
  fullPage: boolean,
  png: Buffer,
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'A valid sessionId is required for screenshot storage.');
  }
  const filePath = path.join(
    screenshotRoot(),
    sessionId,
    fullPage ? 'full-page.png' : 'viewport.png',
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, png);
  return path.resolve(filePath);
}

type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

/**
 * Chromium flags that make embedded media behave the way a user expects.
 *
 * Without an explicit autoplay policy, headless Chromium requires a real user
 * gesture before it will start `<video>`/`<audio>` playback, so the live view
 * only ever showed the poster frame.
 */
const MEDIA_LAUNCH_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
];

function launchOptions(downloadsPath: string, channel: string | undefined): LaunchOptions {
  const options: LaunchOptions = {
    headless: !enabledEnv('FLUJO_BROWSER_HEADED'),
    downloadsPath,
    args: MEDIA_LAUNCH_ARGS,
  };
  if (channel) options.channel = channel;
  // Patchright mutes audio by default. Unmuting only matters where the operator
  // captures host audio, so it stays opt-in.
  if (enabledEnv('FLUJO_BROWSER_AUDIO')) options.ignoreDefaultArgs = ['--mute-audio'];
  if (process.env.FLUJO_BROWSER_EXECUTABLE_PATH) {
    options.executablePath = process.env.FLUJO_BROWSER_EXECUTABLE_PATH;
  }
  return options;
}

/**
 * Preferred Chromium channel.
 *
 * `headless: true` alone resolves to `chrome-headless-shell`, the reduced build
 * with no real compositor — which is why animation and video looked frozen.
 * The full `chromium` channel runs modern headless instead, so screencast
 * frames advance like they do in a headed browser.
 */
function preferredChannel(): string | undefined {
  const configured = process.env.FLUJO_BROWSER_CHANNEL?.trim();
  if (configured) return configured === 'default' ? undefined : configured;
  return process.env.FLUJO_BROWSER_EXECUTABLE_PATH ? undefined : 'chromium';
}

async function acquireBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const downloadsPath = await ensureRuntimeRoot();
    try {
      const channel = preferredChannel();
      let launched: Browser;
      try {
        launched = await chromium.launch(launchOptions(downloadsPath, channel));
      } catch (error) {
        // Deployments that only installed the headless shell have no `chromium`
        // channel; fall back rather than losing the browser entirely.
        if (!channel) throw error;
        launched = await chromium.launch(launchOptions(downloadsPath, undefined));
      }
      browser = launched;
      launched.once('disconnected', () => {
        if (browser === launched) browser = undefined;
        sessions.clear();
        lastSessionId = undefined;
      });
      return launched;
    } catch {
      throw new BrowserMcpError(
        'BROWSER_UNAVAILABLE',
        'Patchright could not start Chromium. Install the managed browser binary and check the server platform prerequisites.',
      );
    } finally {
      browserPromise = undefined;
    }
  })();
  return browserPromise;
}

function validateSessionId(value: unknown): string {
  if (value === undefined || value === '') return randomUUID();
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'sessionId must contain 1-64 letters, digits, underscores, or hyphens.');
  }
  return value;
}

function touchSession(session: BrowserSession): BrowserSession {
  session.touchedAt = Date.now();
  lastSessionId = session.id;
  return session;
}

function lastLiveSession(): BrowserSession | undefined {
  const remembered = lastSessionId ? sessions.get(lastSessionId) : undefined;
  if (remembered && !remembered.page.isClosed()) return remembered;

  let latest: BrowserSession | undefined;
  for (const session of sessions.values()) {
    if (session.page.isClosed()) {
      sessions.delete(session.id);
      continue;
    }
    if (!latest || session.touchedAt >= latest.touchedAt) latest = session;
  }
  lastSessionId = latest?.id;
  return latest;
}

async function closeSessionInternal(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  if (lastSessionId === id) lastSessionId = undefined;
  await session.context.close().catch(() => undefined);
  return true;
}

export async function openSession(requestedId: unknown, signal: AbortSignal): Promise<BrowserSession> {
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  if (requestedId === undefined || requestedId === '') {
    const latest = lastLiveSession();
    if (latest) return touchSession(latest);
  }
  const id = validateSessionId(requestedId);
  const existing = sessions.get(id);
  if (existing) return touchSession(existing);
  const maxSessions = integerEnv('FLUJO_BROWSER_MAX_SESSIONS', DEFAULT_MAX_SESSIONS, 1, 32);
  if (sessions.size >= maxSessions) {
    throw new BrowserMcpError('SESSION_LIMIT', `The browser session limit (${maxSessions}) has been reached.`);
  }

  const activeBrowser = await acquireBrowser();
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');

  let context: BrowserContext | undefined;
  let contextClosePromise: Promise<void> | undefined;
  let cancelled = false;
  const closeContext = (): Promise<void> => {
    if (!context) return Promise.resolve();
    contextClosePromise ??= context.close().catch(() => undefined);
    return contextClosePromise;
  };
  const onAbort = () => {
    cancelled = true;
    void closeContext();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    context = await activeBrowser.newContext({
      acceptDownloads: false,
      // Many streaming and app-shell sites route their media fetches through a
      // service worker, so operators can opt into allowing them.
      serviceWorkers: enabledEnv('FLUJO_BROWSER_ALLOW_SERVICE_WORKERS') ? 'allow' : 'block',
      viewport: defaultViewport(),
    });
    if (cancelled || signal.aborted) {
      throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
    }

    const session: BrowserSession = {
      id,
      context,
      page: await context.newPage(),
      touchedAt: Date.now(),
      documentRequests: 0,
      navigationBlocked: false,
    };
    if (cancelled || signal.aborted) {
      throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
    }
    const maxRedirects = integerEnv('FLUJO_BROWSER_MAX_REDIRECTS', DEFAULT_MAX_REDIRECTS, 0, 50);

    const mainFrame = session.page.mainFrame();
    await context.route('**/*', async (route) => {
      const request = route.request();
      // Only a top-level document counts toward the redirect budget. Counting
      // every `document` request meant an ad- or embed-heavy page tripped the
      // limit on its tenth <iframe> and wedged the whole session.
      let mainDocument = false;
      try {
        mainDocument = request.resourceType() === 'document' && request.frame() === mainFrame;
      } catch {
        mainDocument = false;
      }
      try {
        if (mainDocument) {
          session.documentRequests += 1;
          if (session.documentRequests > maxRedirects + 1) {
            throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The navigation exceeded the redirect limit.');
          }
        }
        await assertNavigationAllowed(request.url());
        await route.continue();
      } catch {
        // Likewise, a blocked tracker pixel or third-party CDN asset must not
        // poison the session flag and make the next click report a bogus
        // NAVIGATION_BLOCKED.
        if (mainDocument) session.navigationBlocked = true;
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    if (cancelled || signal.aborted) {
      throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
    }
    session.page.on('download', (download) => void download.cancel().catch(() => undefined));
    session.page.on('close', () => {
      sessions.delete(id);
      if (lastSessionId === id) lastSessionId = undefined;
    });
    sessions.set(id, session);
    return touchSession(session);
  } catch (error) {
    await closeContext();
    if (cancelled || signal.aborted) {
      throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function getSession(value: unknown): BrowserSession {
  if (value === undefined || value === '') {
    const latest = lastLiveSession();
    if (!latest) throw new BrowserMcpError('NOT_FOUND', 'No active browser session exists.');
    return touchSession(latest);
  }
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'A valid sessionId is required.');
  }
  const session = sessions.get(value);
  if (!session || session.page.isClosed()) {
    sessions.delete(value);
    throw new BrowserMcpError('NOT_FOUND', 'The browser session does not exist or has expired.');
  }
  return touchSession(session);
}

export async function closeSession(value: unknown): Promise<boolean> {
  if (value === undefined || value === '') {
    const latest = lastLiveSession();
    if (!latest) return false;
    return closeSessionInternal(latest.id);
  }
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'A valid sessionId is required.');
  }
  return closeSessionInternal(value);
}

export async function runCancellable<T>(
  session: BrowserSession,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    await closeSessionInternal(session.id);
    throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void closeSessionInternal(session.id).finally(() => {
        reject(new BrowserMcpError('CANCELLED', 'The browser request was cancelled.'));
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation().then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function resetNavigationCounter(session: BrowserSession): void {
  session.documentRequests = 0;
  session.navigationBlocked = false;
}

export function publicPageState(session: BrowserSession): { sessionId: string; url: string } {
  let url = session.page.url();
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    url = parsed.href;
  } catch {
    url = url === 'about:blank' ? url : '';
  }
  return { sessionId: session.id, url };
}

export async function shutdownBrowserRuntime(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeSessionInternal(id)));
  const active = browser;
  browser = undefined;
  lastSessionId = undefined;
  await active?.close().catch(() => undefined);
  if (runtimeRoot) {
    const root = runtimeRoot;
    runtimeRoot = undefined;
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

const idleTimer = setInterval(() => {
  const idleMs = integerEnv('FLUJO_BROWSER_IDLE_TIMEOUT_MS', DEFAULT_IDLE_MS, 10_000, 24 * 60 * 60_000);
  const cutoff = Date.now() - idleMs;
  for (const session of sessions.values()) {
    if (session.touchedAt < cutoff) void closeSessionInternal(session.id);
  }
}, 30_000);
idleTimer.unref();
