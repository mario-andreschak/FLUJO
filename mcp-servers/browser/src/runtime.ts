import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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

export type BrowserFailureCategory = 'cancelled' | 'input' | 'policy' | 'runtime' | 'site';
export type BrowserMode = 'sandbox' | 'trusted';
export type BrowserWindowVisibility = 'minimized' | 'offscreen' | 'visible';

export function failureCategoryForCode(code: BrowserErrorCode): BrowserFailureCategory {
  if (code === 'CANCELLED') return 'cancelled';
  if (code === 'INVALID_ARGUMENT' || code === 'NOT_FOUND' || code === 'SESSION_LIMIT') return 'input';
  if (code === 'NAVIGATION_BLOCKED') return 'policy';
  return 'runtime';
}

export class BrowserMcpError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
    public readonly category: BrowserFailureCategory = failureCategoryForCode(code),
  ) {
    super(message);
    this.name = 'BrowserMcpError';
  }
}

export type PolicyBlock = {
  url: string;
  reason: string;
  topLevel: boolean;
};

export type BrowserSession = {
  id: string;
  mode: BrowserMode;
  context: BrowserContext;
  page: Page;
  touchedAt: number;
  documentRequests: number;
  navigationBlocked: boolean;
  blockedRequestCount: number;
  lastPolicyBlock?: PolicyBlock;
};

type RuntimeLaunchState = {
  mode: BrowserMode;
  channel: string;
  headless: boolean;
  persistent: boolean;
  windowVisibility: BrowserWindowVisibility;
  extensionDirectories: string[];
  profileDir?: string;
  version?: string;
};

let sandboxBrowser: Browser | undefined;
let sandboxBrowserPromise: Promise<Browser> | undefined;
let trustedContext: BrowserContext | undefined;
let trustedContextPromise: Promise<BrowserContext> | undefined;
const launchStates: Partial<Record<BrowserMode, RuntimeLaunchState>> = {};
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

function booleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return undefined;
}

export function browserMode(): BrowserMode {
  return process.env.FLUJO_BROWSER_MODE?.trim().toLowerCase() === 'trusted'
    ? 'trusted'
    : 'sandbox';
}

function browserLocale(): string {
  const configured = process.env.FLUJO_BROWSER_LOCALE?.trim();
  if (configured) return configured;
  return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
}

function browserTimezone(): string {
  const configured = process.env.FLUJO_BROWSER_TIMEZONE_ID?.trim();
  if (configured) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function headed(mode: BrowserMode): boolean {
  return booleanEnv('FLUJO_BROWSER_HEADED') ?? mode === 'trusted';
}

function allowServiceWorkers(mode: BrowserMode): boolean {
  return booleanEnv('FLUJO_BROWSER_ALLOW_SERVICE_WORKERS') ?? mode === 'trusted';
}

function allowPrivateHosts(): boolean {
  return booleanEnv('FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS') ?? true;
}

/**
 * Browser navigation is deliberately open by default: this is an operator-run
 * browser, and its primary job is to inspect the operator's local and remote
 * applications. Deployments that need the former SSRF/origin policy can opt
 * back into it explicitly.
 */
function navigationRestricted(): boolean {
  return enabledEnv('FLUJO_BROWSER_RESTRICT_NAVIGATION');
}

function browserWindowVisibility(): BrowserWindowVisibility {
  const configured = process.env.FLUJO_BROWSER_WINDOW_VISIBILITY?.trim().toLowerCase();
  if (configured === 'offscreen' || configured === 'minimized') return configured;
  return 'visible';
}

function extensionDirectoryInputs(): string[] {
  const raw = process.env.FLUJO_BROWSER_EXTENSION_DIRS?.trim();
  if (!raw) return [];
  return [...new Set(raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean))];
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
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(parsed)));
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

async function normalizeNavigationTarget(input: string): Promise<URL> {
  const raw = input.trim();
  if (!raw) throw new BrowserMcpError('INVALID_ARGUMENT', 'Provide a URL or local file path to navigate to.');

  const windowsPath = /^[A-Za-z]:[\\/]/.test(raw);
  const explicitPath = windowsPath || path.isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../');
  if (explicitPath) return pathToFileURL(path.resolve(raw));
  try {
    await fs.access(path.resolve(raw));
    return pathToFileURL(path.resolve(raw));
  } catch {
    // It is a URL or hostname, not an existing local path.
  }

  // A hostname followed by a numeric port (localhost:4200, app.test:3000)
  // is not a URL scheme. Treat only :// or a non-numeric scheme payload as an
  // explicit protocol.
  if (!/^[A-Za-z][A-Za-z\d+.-]*:(?:\/\/|[^\d])/.test(raw)) {
    const local = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?|[^/\s]+\.local)(?::\d+)?(?:\/|$)/i.test(raw)
      || /^[^/\s]+:\d+(?:\/|$)/.test(raw);
    return new URL(`${local ? 'http' : 'https'}://${raw}`);
  }
  try {
    return new URL(raw);
  } catch {
    throw new BrowserMcpError('INVALID_ARGUMENT', `Could not understand the browser target ${JSON.stringify(raw)}.`);
  }
}

export async function assertNavigationAllowed(input: string): Promise<URL> {
  let url: URL;
  try {
    url = await normalizeNavigationTarget(input);
  } catch (error) {
    if (error instanceof BrowserMcpError) throw error;
    throw new BrowserMcpError('INVALID_ARGUMENT', `Could not understand the browser target ${JSON.stringify(input)}.`);
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol) && !(url.protocol === 'about:' && url.href === 'about:blank')) {
    throw new BrowserMcpError(
      'INVALID_ARGUMENT',
      `The browser cannot navigate to ${url.protocol} targets. Use HTTP(S), a local file path, file://, or about:blank.`,
    );
  }
  if (url.username || url.password) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Remove embedded credentials from the URL and authenticate in the page instead.');
  }

  if (!navigationRestricted() || url.protocol === 'file:' || url.protocol === 'about:') return url;

  const configuredOrigins = allowedOrigins();
  if (configuredOrigins.size > 0 && !configuredOrigins.has(url.origin)) {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The URL origin is not allowed by browser policy.');
  }

  if (!allowPrivateHosts()) {
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

/** Persistence root for `browser_record_*` artifacts (WebM/WAV/muxed output). */
export function recordingRoot(): string {
  const configured = process.env.FLUJO_BROWSER_RECORD_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dataRoot = process.env.FLUJO_DATA_DIR?.trim() || process.cwd();
  return path.resolve(dataRoot, 'recordings', 'browser');
}

/** A fresh scratch directory under the runtime root, used for Playwright's `recordVideo` output before it is copied out. */
export async function ensureScratchDir(prefix: string): Promise<string> {
  const root = await ensureRuntimeRoot();
  const dir = path.join(root, prefix);
  await fs.mkdir(dir, { recursive: true });
  return dir;
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
type PersistentLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

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

function launchOptions(
  downloadsPath: string,
  channel: string | undefined,
  mode: BrowserMode,
): LaunchOptions {
  const args = [...MEDIA_LAUNCH_ARGS];
  if (headed(mode)) {
    const visibility = browserWindowVisibility();
    if (visibility === 'offscreen') {
      args.push('--window-position=-32000,-32000', `--window-size=${defaultViewport().width},${defaultViewport().height}`);
    } else if (visibility === 'minimized') {
      args.push('--start-minimized');
    }
  }
  const options: LaunchOptions = {
    headless: !headed(mode),
    downloadsPath,
    args,
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
function preferredChannel(mode: BrowserMode): string | undefined {
  const configured = process.env.FLUJO_BROWSER_CHANNEL?.trim();
  if (configured) return configured === 'default' ? undefined : configured;
  if (process.env.FLUJO_BROWSER_EXECUTABLE_PATH) return undefined;
  return mode === 'trusted' && extensionDirectoryInputs().length === 0 ? 'chrome' : 'chromium';
}

function trustedProfileDir(): string {
  const configured = process.env.FLUJO_BROWSER_PROFILE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dataRoot = process.env.FLUJO_DATA_DIR?.trim() || process.cwd();
  return path.resolve(dataRoot, 'browser-profile', 'trusted');
}

type ExtensionDescriptor = {
  directory: string;
  manifestVersion: number;
  name: string;
  version: string;
};

async function configuredExtensions(): Promise<ExtensionDescriptor[]> {
  const inputs = extensionDirectoryInputs();
  if (inputs.length > 16) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'FLUJO_BROWSER_EXTENSION_DIRS accepts at most 16 unpacked extension directories.');
  }
  const extensions: ExtensionDescriptor[] = [];
  for (const input of inputs) {
    if (!path.isAbsolute(input)) {
      throw new BrowserMcpError('INVALID_ARGUMENT', 'Every FLUJO_BROWSER_EXTENSION_DIRS entry must be an absolute directory.');
    }
    let directory: string;
    let manifest: Record<string, unknown>;
    try {
      directory = await fs.realpath(input);
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) throw new Error('not a directory');
      const raw = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
      if (raw.length > 1_000_000) throw new Error('manifest too large');
      manifest = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new BrowserMcpError('INVALID_ARGUMENT', `Extension directory is unreadable or has no valid manifest.json: ${input}`);
    }
    const manifestVersion = Number(manifest.manifest_version);
    const name = typeof manifest.name === 'string' ? manifest.name : path.basename(directory);
    const version = typeof manifest.version === 'string' ? manifest.version : '';
    if ((manifestVersion !== 2 && manifestVersion !== 3) || !version) {
      throw new BrowserMcpError('INVALID_ARGUMENT', `Extension manifest must declare manifest_version 2/3 and a version: ${input}`);
    }
    extensions.push({ directory, manifestVersion, name, version });
  }
  return extensions;
}

function persistentLaunchOptions(
  downloadsPath: string,
  channel: string | undefined,
  extensions: ExtensionDescriptor[],
): PersistentLaunchOptions {
  const base = launchOptions(downloadsPath, channel, 'trusted');
  const extensionPaths = extensions.map(({ directory }) => directory);
  const extensionArgs = extensionPaths.length > 0
    ? [
        `--disable-extensions-except=${extensionPaths.join(',')}`,
        `--load-extension=${extensionPaths.join(',')}`,
      ]
    : [];
  return {
    ...base,
    args: [...(base.args ?? []), ...extensionArgs],
    acceptDownloads: false,
    locale: browserLocale(),
    serviceWorkers: allowServiceWorkers('trusted') ? 'allow' : 'block',
    timezoneId: browserTimezone(),
    viewport: defaultViewport(),
  };
}

async function launchSandboxBrowser(downloadsPath: string): Promise<{ browser: Browser; channel: string }> {
  const requested = preferredChannel('sandbox');
  try {
    return {
      browser: await chromium.launch(launchOptions(downloadsPath, requested, 'sandbox')),
      channel: requested ?? 'default',
    };
  } catch (error) {
    if (!requested) throw error;
    return {
      browser: await chromium.launch(launchOptions(downloadsPath, undefined, 'sandbox')),
      channel: 'default',
    };
  }
}

/** Exported for the recording/capture modules, which need their own contexts on the same browser instance. */
export async function acquireBrowser(): Promise<Browser> {
  if (sandboxBrowser?.isConnected()) return sandboxBrowser;
  if (sandboxBrowserPromise) return sandboxBrowserPromise;
  sandboxBrowserPromise = (async () => {
    const downloadsPath = await ensureRuntimeRoot();
    try {
      const { browser: launched, channel } = await launchSandboxBrowser(downloadsPath);
      sandboxBrowser = launched;
      launchStates.sandbox = {
        mode: 'sandbox',
        channel,
        headless: !headed('sandbox'),
        persistent: false,
        windowVisibility: browserWindowVisibility(),
        extensionDirectories: [],
        version: typeof launched.version === 'function' ? launched.version() : undefined,
      };
      launched.once('disconnected', () => {
        if (sandboxBrowser === launched) sandboxBrowser = undefined;
        delete launchStates.sandbox;
        for (const [id, session] of sessions) {
          if (session.mode === 'sandbox') sessions.delete(id);
        }
        if (lastSessionId && !sessions.has(lastSessionId)) lastSessionId = undefined;
      });
      return launched;
    } catch {
      throw new BrowserMcpError(
        'BROWSER_UNAVAILABLE',
        'Patchright could not start Chromium. Install the managed browser binary and check the server platform prerequisites.',
      );
    } finally {
      sandboxBrowserPromise = undefined;
    }
  })();
  return sandboxBrowserPromise;
}

async function acquireTrustedContext(): Promise<BrowserContext> {
  if (trustedContext) return trustedContext;
  if (trustedContextPromise) return trustedContextPromise;
  trustedContextPromise = (async () => {
    try {
      const downloadsPath = await ensureRuntimeRoot();
    const profileDir = trustedProfileDir();
    await fs.mkdir(profileDir, { recursive: true });
    const extensions = await configuredExtensions();
    const requested = preferredChannel('trusted');
    if (extensions.length > 0 && requested !== 'chromium') {
      throw new BrowserMcpError(
        'INVALID_ARGUMENT',
        'Unpacked extensions require FLUJO_BROWSER_CHANNEL=chromium because current Google Chrome/Edge releases removed the side-load command-line flags.',
      );
    }
      let context: BrowserContext;
      let channel = requested ?? 'default';
      try {
        context = await chromium.launchPersistentContext(
          profileDir,
          persistentLaunchOptions(downloadsPath, requested, extensions),
        );
      } catch (error) {
        if (!requested) throw error;
        const fallbackChannel = requested === 'chromium' ? undefined : 'chromium';
        context = await chromium.launchPersistentContext(
          profileDir,
          persistentLaunchOptions(downloadsPath, fallbackChannel, extensions),
        );
        channel = fallbackChannel ?? 'default';
      }
      trustedContext = context;
      launchStates.trusted = {
        mode: 'trusted',
        channel,
        headless: !headed('trusted'),
        persistent: true,
        windowVisibility: browserWindowVisibility(),
        extensionDirectories: extensions.map(({ directory }) => directory),
        profileDir,
        version: context.browser()?.version(),
      };
      await installRequestPolicy(context);
      context.once('close', () => {
        if (trustedContext === context) trustedContext = undefined;
        delete launchStates.trusted;
        for (const [id, session] of sessions) {
          if (session.mode === 'trusted') sessions.delete(id);
        }
        if (lastSessionId && !sessions.has(lastSessionId)) lastSessionId = undefined;
      });
      return context;
    } catch (error) {
      if (error instanceof BrowserMcpError) throw error;
      throw new BrowserMcpError(
        'BROWSER_UNAVAILABLE',
        'Patchright could not start the trusted Chrome profile. Install Chrome (or configure FLUJO_BROWSER_EXECUTABLE_PATH), ensure the profile is not in use, and check that a desktop display is available.',
      );
    } finally {
      trustedContextPromise = undefined;
    }
  })();
  return trustedContextPromise;
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

function lastLiveSession(mode?: BrowserMode): BrowserSession | undefined {
  const remembered = lastSessionId ? sessions.get(lastSessionId) : undefined;
  if (remembered && !remembered.page.isClosed() && (!mode || remembered.mode === mode)) return remembered;

  let latest: BrowserSession | undefined;
  for (const session of sessions.values()) {
    if (session.page.isClosed()) {
      sessions.delete(session.id);
      continue;
    }
    if ((!mode || session.mode === mode) && (!latest || session.touchedAt >= latest.touchedAt)) latest = session;
  }
  lastSessionId = latest?.id;
  return latest;
}

async function closeSessionInternal(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  if (lastSessionId === id) lastSessionId = undefined;
  if (session.mode === 'trusted') {
    await session.page.close().catch(() => undefined);
  } else {
    await session.context.close().catch(() => undefined);
  }
  return true;
}

function policyDisplayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function sessionForPage(page: Page | undefined): BrowserSession | undefined {
  if (!page) return undefined;
  for (const session of sessions.values()) {
    if (session.page === page) return session;
  }
  return undefined;
}

/** Enforce the same SSRF/navigation policy on sessions, recordings, and capture contexts. */
export async function installRequestPolicy(context: BrowserContext): Promise<void> {
  if (!navigationRestricted()) return;
  await context.route('**/*', async (route) => {
    const request = route.request();
    let session: BrowserSession | undefined;
    let mainDocument = false;
    try {
      const frame = request.frame();
      session = sessionForPage(frame.page());
      mainDocument = Boolean(
        session
        && request.resourceType() === 'document'
        && frame === session.page.mainFrame(),
      );
    } catch {
      // Service-worker and pre-frame requests still receive the URL policy, but
      // cannot be attributed to a user-facing tab.
    }

    try {
      if (mainDocument && session) {
        session.documentRequests += 1;
        const maxRedirects = integerEnv('FLUJO_BROWSER_MAX_REDIRECTS', DEFAULT_MAX_REDIRECTS, 0, 50);
        if (session.documentRequests > maxRedirects + 1) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The navigation exceeded the redirect limit.');
        }
      }
      await assertNavigationAllowed(request.url());
      await route.continue();
    } catch (error) {
      if (session) {
        session.blockedRequestCount += 1;
        session.lastPolicyBlock = {
          url: policyDisplayUrl(request.url()),
          reason: error instanceof BrowserMcpError
            ? error.message
            : 'The request was blocked by browser policy.',
          topLevel: mainDocument,
        };
        // A blocked tracker/CDN must not turn the next click into a bogus
        // top-level NAVIGATION_BLOCKED result.
        if (mainDocument) session.navigationBlocked = true;
      }
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
}

function reusableTrustedPage(context: BrowserContext): Page | undefined {
  const used = new Set([...sessions.values()].map((session) => session.page));
  return context.pages().find((page) =>
    !used.has(page) && !page.isClosed() && page.url() === 'about:blank'
  );
}

export async function openSession(requestedId: unknown, signal: AbortSignal): Promise<BrowserSession> {
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  const mode = browserMode();
  if (requestedId === undefined || requestedId === '') {
    const latest = lastLiveSession(mode);
    if (latest) return touchSession(latest);
  }
  const id = validateSessionId(requestedId);
  const existing = sessions.get(id);
  if (existing) return touchSession(existing);
  const maxSessions = integerEnv('FLUJO_BROWSER_MAX_SESSIONS', DEFAULT_MAX_SESSIONS, 1, 32);
  if (sessions.size >= maxSessions) {
    throw new BrowserMcpError('SESSION_LIMIT', `The browser session limit (${maxSessions}) has been reached.`);
  }

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let closeCreatedPromise: Promise<void> | undefined;
  let cancelled = false;
  const closeCreated = (): Promise<void> => {
    if (!context) return Promise.resolve();
    closeCreatedPromise ??= mode === 'trusted'
      ? (page?.close().catch(() => undefined) ?? Promise.resolve())
      : context.close().catch(() => undefined);
    return closeCreatedPromise;
  };
  const onAbort = () => {
    cancelled = true;
    void closeCreated();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (mode === 'trusted') {
      context = await acquireTrustedContext();
      page = reusableTrustedPage(context) ?? await context.newPage();
    } else {
      const activeBrowser = await acquireBrowser();
      if (cancelled || signal.aborted) {
        throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
      }
      context = await activeBrowser.newContext({
        acceptDownloads: false,
        locale: browserLocale(),
        serviceWorkers: allowServiceWorkers('sandbox') ? 'allow' : 'block',
        timezoneId: browserTimezone(),
        viewport: defaultViewport(),
      });
      page = await context.newPage();
      await installRequestPolicy(context);
    }
    const session: BrowserSession = {
      id,
      mode,
      context,
      page,
      touchedAt: Date.now(),
      documentRequests: 0,
      navigationBlocked: false,
      blockedRequestCount: 0,
    };
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
    await closeCreated();
    if (cancelled || signal.aborted) {
      throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Register a session created outside `openSession()` (used by the recording module, which owns its own context lifecycle). */
export function registerSession(session: BrowserSession): BrowserSession {
  sessions.set(session.id, session);
  return touchSession(session);
}

export type CaptureContext = { context: BrowserContext; page: Page };

/**
 * An ephemeral, isolated context for still capture: not the user-facing
 * session map, no `lastSessionId` side effects, always closed by the caller
 * in a `finally`. `reducedMotion: 'reduce'` plus the caller's `animations:
 * 'disabled'` screenshot option are the two halves of the determinism ladder.
 */
export async function createCaptureContext(
  signal: AbortSignal,
  viewport: { width: number; height: number; deviceScaleFactor?: number; colorScheme?: 'light' | 'dark' },
): Promise<CaptureContext> {
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  const activeBrowser = await acquireBrowser();
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  const context = await activeBrowser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    colorScheme: viewport.colorScheme ?? 'light',
    locale: browserLocale(),
    timezoneId: browserTimezone(),
    reducedMotion: 'reduce',
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  try {
    await installRequestPolicy(context);
    const page = await context.newPage();
    if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
    return { context, page };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
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
  session.blockedRequestCount = 0;
  session.lastPolicyBlock = undefined;
}

export function publicPageState(session: BrowserSession): {
  sessionId: string;
  url: string;
  mode: BrowserMode;
  policy: { blockedRequestCount: number; lastBlockedRequest?: PolicyBlock };
} {
  let url = session.page.url();
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    url = parsed.href;
  } catch {
    url = url === 'about:blank' ? url : '';
  }
  return {
    sessionId: session.id,
    url,
    mode: session.mode,
    policy: {
      blockedRequestCount: session.blockedRequestCount,
      ...(session.lastPolicyBlock ? { lastBlockedRequest: session.lastPolicyBlock } : {}),
    },
  };
}

export async function browserDiagnostics(session?: BrowserSession): Promise<Record<string, unknown>> {
  const mode = session?.mode ?? browserMode();
  const state = launchStates[mode];
  const page = session?.page;
  let fingerprint: Record<string, unknown> | undefined;
  if (page && !page.isClosed()) {
    fingerprint = await page.evaluate(() => {
      const nav = navigator as Navigator & {
        userAgentData?: { brands: Array<{ brand: string; version: string }>; mobile: boolean; platform: string };
        webdriver?: boolean;
      };
      return {
        userAgent: nav.userAgent,
        userAgentBrands: nav.userAgentData?.brands ?? [],
        userAgentPlatform: nav.userAgentData?.platform,
        webdriver: nav.webdriver,
        language: nav.language,
        languages: [...nav.languages],
        platform: nav.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }).catch(() => undefined);
  }
  return {
    success: true,
    mode,
    launched: Boolean(state),
    channel: state?.channel ?? preferredChannel(mode) ?? 'default',
    headless: state?.headless ?? !headed(mode),
    persistentProfile: state?.persistent ?? mode === 'trusted',
    windowVisibility: state?.windowVisibility ?? browserWindowVisibility(),
    version: state?.version,
    locale: browserLocale(),
    timezone: browserTimezone(),
    serviceWorkers: allowServiceWorkers(mode) ? 'allow' : 'block',
    privateHosts: allowPrivateHosts() ? 'allow' : 'block',
    allowedOrigins: [...allowedOrigins()],
    ...(session ? { session: publicPageState(session) } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

async function installedProfileExtensions(): Promise<Array<Record<string, unknown>>> {
  const preferencesPath = path.join(trustedProfileDir(), 'Default', 'Preferences');
  try {
    const stat = await fs.stat(preferencesPath);
    if (!stat.isFile() || stat.size > 50_000_000) return [];
    const preferences = JSON.parse(await fs.readFile(preferencesPath, 'utf8')) as {
      extensions?: { settings?: Record<string, Record<string, unknown>> };
    };
    const settings = preferences.extensions?.settings ?? {};
    return Object.entries(settings).flatMap(([id, entry]) => {
      const manifest = entry.manifest;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
      const record = manifest as Record<string, unknown>;
      return [{
        id,
        name: typeof record.name === 'string' ? record.name : id,
        version: typeof record.version === 'string' ? record.version : '',
        enabled: entry.state === 1,
        source: 'profile',
      }];
    });
  } catch {
    return [];
  }
}

export async function browserExtensions(): Promise<Record<string, unknown>> {
  const configured = await configuredExtensions();
  const activeUrls = trustedContext
    ? [
        ...trustedContext.serviceWorkers().map((worker) => worker.url()),
        ...trustedContext.backgroundPages().map((page) => page.url()),
      ]
    : [];
  const activeIds = [...new Set(activeUrls.flatMap((url) => {
    const match = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/i.exec(url);
    return match ? [match[1]] : [];
  }))];
  return {
    success: true,
    profile: trustedProfileDir(),
    configuredUnpacked: configured,
    installed: await installedProfileExtensions(),
    activeExtensionIds: activeIds,
    note: 'Extensions belong only to FLUJO\'s dedicated trusted profile. Unpacked directories are operator allowlisted; FLUJO never copies extensions from the personal Chrome profile.',
  };
}

export async function shutdownBrowserRuntime(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeSessionInternal(id)));
  const activeSandbox = sandboxBrowser;
  const activeTrusted = trustedContext;
  sandboxBrowser = undefined;
  trustedContext = undefined;
  lastSessionId = undefined;
  delete launchStates.sandbox;
  delete launchStates.trusted;
  await activeTrusted?.close().catch(() => undefined);
  await activeSandbox?.close().catch(() => undefined);
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
