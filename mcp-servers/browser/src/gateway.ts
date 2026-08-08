import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CDPSession } from 'patchright';
import {
  enabledEnv,
  getSession,
  integerEnv,
  type BrowserSession,
} from './runtime.js';
import { renderBrowserViewHtml } from './viewHtml.js';
import { audioTapSource } from './audioTap.js';

/**
 * Loopback media gateway for the browser MCP App.
 *
 * The MCP tool channel can only carry one screenshot per JSON-RPC round trip,
 * which is why the app used to look like a slideshow and why anything that
 * actually moves (video, canvas, CSS animation) never rendered. This gateway
 * moves pixels and input off that channel:
 *
 *   GET  /view    the browser UI itself, served from this origin
 *   GET  /stream  multipart/x-mixed-replace MJPEG fed by CDP Page.startScreencast
 *   GET  /audio   chunked PCM tapped out of the page's Web Audio graph
 *   GET  /events  Server-Sent Events carrying url/title/loading transitions
 *   POST /input   low-latency mouse, wheel, keyboard, and viewport events
 *
 * `/view` is what the MCP App iframes (via `_meta.ui.csp.frameDomains`), the
 * same pattern the VS Code MCP App uses to embed OpenVSCode. Because the UI
 * then runs on a real origin rather than inside the host's app sandbox, it is
 * not bound by the app CSP and can behave like an actual browser window.
 *
 * It binds to loopback only and requires a per-process bearer token that is
 * templated straight into the app HTML, so the token never reaches the model.
 */

const MJPEG_BOUNDARY = 'flujoframe';
const MAX_INPUT_BYTES = 16_384;
const SSE_HEARTBEAT_MS = 15_000;
/** Drop frames instead of buffering when a client cannot keep up. */
const MAX_STREAM_BACKLOG_BYTES = 4_000_000;
/** Audio is small, but a stalled listener must not grow the heap either. */
const MAX_AUDIO_BACKLOG_BYTES = 1_000_000;
/** CDP binding the in-page audio tap posts its PCM chunks through. */
const AUDIO_BINDING = '__flujoAudioChunk';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '600',
};

export type BrowserGatewayEndpoint = {
  /** Origin the MCP App connects to, e.g. `http://127.0.0.1:53411`. */
  origin: string;
  /** Bearer token required on every gateway request. */
  token: string;
};

type SessionChannel = {
  sessionId: string;
  session: BrowserSession;
  frameClients: Set<ServerResponse>;
  eventClients: Set<ServerResponse>;
  audioClients: Set<ServerResponse>;
  cdp?: CDPSession;
  screencasting: boolean;
  audioTapped: boolean;
  audioPreparePromise?: Promise<void>;
  audioExecutionContexts: Set<number>;
  audioSignal: boolean;
  lastFrame?: Buffer;
  inputChain: Promise<unknown>;
  disposed: boolean;
  dispose: () => void;
};

let httpServer: HttpServer | undefined;
let endpoint: BrowserGatewayEndpoint | undefined;
let startPromise: Promise<BrowserGatewayEndpoint | undefined> | undefined;
const channels = new Map<string, SessionChannel>();

function streamEnabled(): boolean {
  const raw = process.env.FLUJO_BROWSER_STREAM_ENABLED?.trim();
  if (!raw) return true;
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Escape hatch for hosted deployments behind a reverse proxy that rewrites
 * `Host`/`Referer` headers. Mirrors the MCP Apps sandbox escape hatch: when the
 * persisted `network.allowAllMcpAppContent` setting is enabled (propagated here
 * by scripts/exposure-mode.mjs as `FLUJO_MCP_APP_SANDBOX_ALLOW_ALL`), the
 * browser live-view gateway accepts any `Host` header and widens its CSP grants
 * so the app can frame the gateway regardless of origin. This disables the
 * DNS-rebinding guard and is intended only as a temporary escape hatch; the
 * long-term fix is correct `FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN` config.
 */
function sandboxAllowAll(): boolean {
  const value = process.env.FLUJO_MCP_APP_SANDBOX_ALLOW_ALL;
  if (!value) return false;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function bindHost(): string {
  const configured = process.env.FLUJO_BROWSER_STREAM_HOST?.trim();
  if (configured) return configured;
  // Under the escape hatch, bind all interfaces so a hosted reverse proxy can
  // reach the gateway; otherwise stay on loopback.
  return sandboxAllowAll() ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Advertised origin. Defaults to the bound loopback address; operators running
 * FLUJO behind a reverse proxy can point the app somewhere reachable instead.
 */
function publicOrigin(port: number): string {
  const configured = process.env.FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // A malformed override never replaces the safe loopback default.
    }
  }
  const host = bindHost();
  const literal = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${literal.includes(':') ? `[${literal}]` : literal}:${port}`;
}

/** Exported for tests: whether the escape hatch is active. */
export function browserSandboxAllowAll(): boolean {
  return sandboxAllowAll();
}

function tokenMatches(provided: string | null): boolean {
  if (!endpoint || !provided) return false;
  const expected = Buffer.from(endpoint.token, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Reject DNS-rebinding attempts that resolve some public name to our port. */
function hostHeaderAllowed(req: IncomingMessage): boolean {
  // Escape hatch: accept any Host header so a hosted reverse proxy that
  // rewrites Host can forward to the gateway. Disables the DNS-rebinding guard.
  if (sandboxAllowAll()) return true;
  const header = (req.headers.host ?? '').toLowerCase();
  if (!header) return false;
  const hostname = header.startsWith('[')
    ? header.slice(1, header.indexOf(']'))
    : header.split(':')[0];
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true;
  const configured = process.env.FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN?.trim();
  if (!configured) return false;
  try {
    return new URL(configured).hostname.toLowerCase().replace(/^\[|\]$/g, '') === hostname;
  } catch {
    return false;
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

function resolveChannel(sessionId: string): SessionChannel {
  const existing = channels.get(sessionId);
  if (existing && !existing.disposed) {
    // Re-validate so the idle reaper sees the session as active while streaming.
    getSession(sessionId);
    return existing;
  }
  const session = getSession(sessionId);
  const channel: SessionChannel = {
    sessionId: session.id,
    session,
    frameClients: new Set(),
    eventClients: new Set(),
    audioClients: new Set(),
    screencasting: false,
    audioTapped: false,
    audioExecutionContexts: new Set(),
    audioSignal: false,
    inputChain: Promise.resolve(),
    disposed: false,
    dispose: () => undefined,
  };
  const onClose = () => disposeChannel(channel);
  const onNavigated = (frame: unknown) => {
    if (frame === session.page.mainFrame()) {
      channel.audioSignal = false;
      void emitState(channel, 'loading');
    }
  };
  const onLoad = () => {
    void emitState(channel, 'idle');
    if (channel.audioClients.size > 0) void setAudioMuted(channel, false);
  };
  session.page.once('close', onClose);
  session.page.on('framenavigated', onNavigated);
  session.page.on('domcontentloaded', onLoad);
  session.page.on('load', onLoad);
  channel.dispose = () => {
    session.page.off('framenavigated', onNavigated);
    session.page.off('domcontentloaded', onLoad);
    session.page.off('load', onLoad);
  };
  channels.set(session.id, channel);
  return channel;
}

function disposeChannel(channel: SessionChannel): void {
  if (channel.disposed) return;
  channel.disposed = true;
  channels.delete(channel.sessionId);
  channel.dispose();
  for (const client of channel.frameClients) client.end();
  for (const client of channel.eventClients) client.end();
  for (const client of channel.audioClients) client.end();
  channel.frameClients.clear();
  channel.eventClients.clear();
  channel.audioClients.clear();
  const cdp = channel.cdp;
  channel.cdp = undefined;
  channel.screencasting = false;
  channel.audioTapped = false;
  channel.audioPreparePromise = undefined;
  channel.audioExecutionContexts.clear();
  void cdp?.detach().catch(() => undefined);
}

async function emitState(channel: SessionChannel, phase: 'loading' | 'idle'): Promise<void> {
  if (channel.disposed || channel.eventClients.size === 0) return;
  // The app is a user-facing surface behind a loopback token, so unlike the
  // model-facing tool payloads it may show the real URL including its query.
  const url = channel.session.page.url();
  const title = await channel.session.page.title().catch(() => '');
  const payload = JSON.stringify({
    sessionId: channel.sessionId,
    url,
    title,
    phase,
    viewport: channel.session.page.viewportSize(),
    audio: audioEnabled(),
    audioSignal: channel.audioSignal,
  });
  for (const client of channel.eventClients) {
    client.write(`event: state\ndata: ${payload}\n\n`);
  }
}

/** One CDP session per browser session, shared by the screencast and audio tap. */
async function ensureCdp(channel: SessionChannel): Promise<CDPSession> {
  if (channel.cdp) return channel.cdp;
  const cdp = await channel.session.context.newCDPSession(channel.session.page);
  channel.cdp = cdp;
  return cdp;
}

async function startScreencast(channel: SessionChannel): Promise<void> {
  if (channel.screencasting || channel.disposed) return;
  channel.screencasting = true;
  try {
    const cdp = await ensureCdp(channel);
    cdp.on('Page.screencastFrame', (frame) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
      const buffer = Buffer.from(frame.data, 'base64');
      channel.lastFrame = buffer;
      broadcastFrame(channel, buffer);
    });
    // Headless Chromium throttles rendering (and therefore video) on a page it
    // believes is unfocused; emulating focus is what keeps playback running.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: integerEnv('FLUJO_BROWSER_STREAM_QUALITY', 55, 10, 95),
      maxWidth: integerEnv('FLUJO_BROWSER_STREAM_MAX_WIDTH', 1600, 320, 3840),
      maxHeight: integerEnv('FLUJO_BROWSER_STREAM_MAX_HEIGHT', 1200, 240, 2160),
      everyNthFrame: 1,
    });
  } catch {
    channel.screencasting = false;
  }
}

async function stopScreencast(channel: SessionChannel): Promise<void> {
  if (!channel.screencasting) return;
  channel.screencasting = false;
  await channel.cdp?.send('Page.stopScreencast').catch(() => undefined);
}

function broadcastFrame(channel: SessionChannel, jpeg: Buffer): void {
  const header = Buffer.from(
    `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    'ascii',
  );
  for (const client of channel.frameClients) {
    // Never queue frames for a client that already fell behind: a stalled
    // socket must degrade to a lower frame rate, not to unbounded memory.
    if (client.writableLength > MAX_STREAM_BACKLOG_BYTES) continue;
    client.write(header);
    client.write(jpeg);
    client.write('\r\n');
  }
}

/** Audio capture is on by default; operators can drop it to save bandwidth. */
function audioEnabled(): boolean {
  const raw = process.env.FLUJO_BROWSER_STREAM_AUDIO?.trim();
  if (!raw) return true;
  return /^(1|true|yes|on)$/i.test(raw);
}

async function evaluateInAudioContexts(channel: SessionChannel, expression: string): Promise<void> {
  const cdp = channel.cdp;
  if (!cdp) return;
  const contextIds = [...channel.audioExecutionContexts];
  if (contextIds.length === 0) {
    await cdp.send('Runtime.evaluate', { expression }).catch(() => undefined);
    return;
  }
  await Promise.all(contextIds.map(async (contextId) => {
    const result = await cdp.send('Runtime.evaluate', { expression, contextId }).catch(() => undefined);
    if (result && 'exceptionDetails' in result && result.exceptionDetails) {
      channel.audioExecutionContexts.delete(contextId);
    }
  }));
}

async function prepareAudio(channel: SessionChannel): Promise<void> {
  if (channel.disposed || !audioEnabled() || channel.audioTapped) return;
  if (channel.audioPreparePromise) return channel.audioPreparePromise;
  channel.audioPreparePromise = (async () => {
    const cdp = await ensureCdp(channel);
    cdp.on('Runtime.executionContextCreated', (event) => {
      const isDefault = (event.context.auxData as Record<string, unknown> | undefined)?.isDefault;
      if (isDefault !== true && isDefault !== 'true') return;
      channel.audioExecutionContexts.add(event.context.id);
      if (channel.audioClients.size > 0) {
        void cdp.send('Runtime.evaluate', {
          expression: 'window.__flujoAudioMuted = false;',
          contextId: event.context.id,
        }).catch(() => undefined);
      }
    });
    cdp.on('Runtime.executionContextDestroyed', (event) => {
      channel.audioExecutionContexts.delete(event.executionContextId);
    });
    cdp.on('Runtime.executionContextsCleared', () => channel.audioExecutionContexts.clear());
    cdp.on('Runtime.bindingCalled', (event) => {
      if (event.name !== AUDIO_BINDING) return;
      broadcastAudio(channel, event.payload);
    });
    // The hook must exist before the first page navigation. It stays muted until
    // /audio has a listener, so an idle live session pays no base64/CDP cost.
    const source = audioTapSource(AUDIO_BINDING, true);
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: AUDIO_BINDING });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    // Also recover the current document (for reused sessions and about:blank).
    await evaluateInAudioContexts(channel, source);
    channel.audioTapped = true;
  })();
  try {
    await channel.audioPreparePromise;
  } finally {
    channel.audioPreparePromise = undefined;
  }
}

async function setAudioMuted(channel: SessionChannel, muted: boolean): Promise<void> {
  if (!channel.audioTapped) return;
  await evaluateInAudioContexts(
    channel,
    `window.__flujoAudioMuted = ${muted ? 'true' : 'false'};`,
  );
}

async function startAudio(channel: SessionChannel): Promise<void> {
  if (channel.disposed || !audioEnabled()) return;
  await prepareAudio(channel);
  await setAudioMuted(channel, false);
}

/** Leave the tap installed but stop paying for chunks nobody is listening to. */
async function stopAudio(channel: SessionChannel): Promise<void> {
  if (!channel.audioTapped) return;
  await setAudioMuted(channel, true);
}

/**
 * Frame one PCM chunk for the wire.
 *
 * Header is little-endian `[sampleRate u32, channels u32, byteLength u32]`,
 * followed by interleaved 16-bit samples. Self-describing per chunk so a client
 * can join the stream at any point and survive a sample-rate change.
 */
function broadcastAudio(channel: SessionChannel, payload: string): void {
  if (channel.audioClients.size === 0) return;
  let rate: number;
  let pcm: Buffer;
  try {
    const parsed = JSON.parse(payload) as { rate?: unknown; pcm?: unknown };
    if (typeof parsed.rate !== 'number' || typeof parsed.pcm !== 'string') return;
    rate = Math.trunc(parsed.rate);
    pcm = Buffer.from(parsed.pcm, 'base64');
  } catch {
    return;
  }
  if (!pcm.length || rate < 8_000 || rate > 192_000) return;
  if (!channel.audioSignal) {
    channel.audioSignal = true;
    void emitState(channel, 'idle');
  }
  const header = Buffer.alloc(12);
  header.writeUInt32LE(rate, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(pcm.length, 8);
  for (const client of channel.audioClients) {
    if (client.writableLength > MAX_AUDIO_BACKLOG_BYTES) continue;
    client.write(header);
    client.write(pcm);
  }
}

function handleAudio(channel: SessionChannel, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    connection: 'close',
    ...CORS_HEADERS,
  });
  res.socket?.setNoDelay(true);
  channel.audioClients.add(res);
  const detach = () => {
    channel.audioClients.delete(res);
    if (channel.audioClients.size === 0) void stopAudio(channel);
  };
  req.once('close', detach);
  res.once('close', detach);
  void startAudio(channel);
}

function handleStream(channel: SessionChannel, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    connection: 'close',
    ...CORS_HEADERS,
  });
  res.socket?.setNoDelay(true);
  channel.frameClients.add(res);
  if (channel.lastFrame) broadcastFrame(channel, channel.lastFrame);
  const detach = () => {
    channel.frameClients.delete(res);
    if (channel.frameClients.size === 0) void stopScreencast(channel);
  };
  req.once('close', detach);
  res.once('close', detach);
  void startScreencast(channel);
}

function handleEvents(channel: SessionChannel, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    ...CORS_HEADERS,
  });
  res.socket?.setNoDelay(true);
  channel.eventClients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
  heartbeat.unref();
  const detach = () => {
    clearInterval(heartbeat);
    channel.eventClients.delete(res);
  };
  req.once('close', detach);
  res.once('close', detach);
  void emitState(channel, 'idle');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Input payload is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mouseButton(value: unknown): 'left' | 'right' | 'middle' {
  return value === 'right' || value === 'middle' ? value : 'left';
}

/**
 * Dispatch one app input event. Everything is funnelled through a per-session
 * promise chain so a fast typist can never interleave two Playwright input
 * calls on the same page.
 */
async function dispatchInput(channel: SessionChannel, event: Record<string, unknown>): Promise<void> {
  const { page } = channel.session;
  const type = String(event.type ?? '');
  if (type === 'mousemove') {
    await page.mouse.move(finiteNumber(event.x), finiteNumber(event.y));
    return;
  }
  if (type === 'mousedown' || type === 'mouseup') {
    const button = mouseButton(event.button);
    const clickCount = Math.min(3, Math.max(1, Math.trunc(finiteNumber(event.clickCount, 1))));
    await page.mouse.move(finiteNumber(event.x), finiteNumber(event.y));
    if (type === 'mousedown') await page.mouse.down({ button, clickCount });
    else await page.mouse.up({ button, clickCount });
    return;
  }
  if (type === 'wheel') {
    await page.mouse.wheel(finiteNumber(event.deltaX), finiteNumber(event.deltaY));
    return;
  }
  if (type === 'keydown' || type === 'keyup') {
    const key = typeof event.key === 'string' ? event.key : '';
    if (!key || key.length > 64) return;
    if (type === 'keydown') await page.keyboard.down(key);
    else await page.keyboard.up(key);
    return;
  }
  if (type === 'text') {
    const text = typeof event.text === 'string' ? event.text : '';
    if (text) await page.keyboard.insertText(text.slice(0, 4_096));
    return;
  }
  if (type === 'viewport') {
    const width = Math.trunc(finiteNumber(event.width));
    const height = Math.trunc(finiteNumber(event.height));
    if (width < 320 || height < 240 || width > 3840 || height > 2160) return;
    const current = page.viewportSize();
    if (current && current.width === width && current.height === height) return;
    await page.setViewportSize({ width, height });
  }
}

async function handleInput(channel: SessionChannel, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let events: unknown;
  try {
    events = JSON.parse(await readBody(req));
  } catch {
    respondJson(res, 400, { error: 'Malformed input payload.' });
    return;
  }
  const list = Array.isArray(events) ? events : [events];
  if (list.length > 64) {
    respondJson(res, 400, { error: 'Too many input events in one batch.' });
    return;
  }
  const run = channel.inputChain.then(async () => {
    for (const event of list) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      await dispatchInput(channel, event as Record<string, unknown>);
    }
  });
  // Keep the chain alive even when one event throws, otherwise a single failed
  // dispatch would deadlock every later keystroke for this session.
  channel.inputChain = run.catch(() => undefined);
  try {
    await run;
    respondJson(res, 200, { ok: true });
  } catch (error) {
    respondJson(res, 200, { ok: false, error: error instanceof Error ? error.message : 'Input failed.' });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (!hostHeaderAllowed(req)) {
    respondJson(res, 403, { error: 'Forbidden host.' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    respondJson(res, 200, { ok: true });
    return;
  }
  if (!tokenMatches(url.searchParams.get('t'))) {
    respondJson(res, 403, { error: 'Invalid gateway token.' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/view') {
    // No X-Frame-Options and no frame-ancestors: the MCP App sandbox origin is
    // unknown here, and the bearer token is what actually gates access.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(renderBrowserViewHtml());
    return;
  }
  const sessionId = url.searchParams.get('s') ?? '';
  let channel: SessionChannel;
  try {
    channel = resolveChannel(sessionId);
  } catch (error) {
    respondJson(res, 404, { error: error instanceof Error ? error.message : 'Unknown session.' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stream') {
    handleStream(channel, req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/audio') {
    if (!audioEnabled()) {
      respondJson(res, 404, { error: 'Audio capture is disabled.' });
      return;
    }
    handleAudio(channel, req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    handleEvents(channel, req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/input') {
    await handleInput(channel, req, res);
    return;
  }
  respondJson(res, 404, { error: 'Unknown gateway endpoint.' });
}

/**
 * Start (or reuse) the loopback gateway. Resolves to `undefined` when streaming
 * is disabled or the listener cannot bind, so the MCP App can fall back to the
 * screenshot poll loop instead of failing to render at all.
 */
export async function ensureBrowserGateway(): Promise<BrowserGatewayEndpoint | undefined> {
  if (!streamEnabled()) return undefined;
  if (endpoint) return endpoint;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    try {
      const server = createServer((req, res) => {
        void handleRequest(req, res).catch(() => {
          if (!res.headersSent) respondJson(res, 500, { error: 'Gateway failure.' });
          else res.end();
        });
      });
      server.on('error', () => undefined);
      // Screencast sockets are long-lived by design; the per-session idle
      // reaper in runtime.ts is what bounds their lifetime.
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      server.keepAliveTimeout = 0;
      server.timeout = 0;
      const port = integerEnv('FLUJO_BROWSER_STREAM_PORT', 0, 0, 65_535);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bindHost(), () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      server.unref();
      httpServer = server;
      endpoint = {
        origin: publicOrigin((server.address() as AddressInfo).port),
        token: randomBytes(32).toString('base64url'),
      };
      return endpoint;
    } catch {
      httpServer = undefined;
      return undefined;
    } finally {
      startPromise = undefined;
    }
  })();
  return startPromise;
}

/** Current endpoint, or `undefined` when the gateway has not started. */
export function browserGatewayEndpoint(): BrowserGatewayEndpoint | undefined {
  return endpoint;
}

/**
 * Install the main-world audio interception before a navigation can create an
 * AudioContext or fire a media element's play event. Capture remains muted
 * until a client opens /audio. Failure is intentionally non-fatal: browser
 * navigation and the screenshot stream must continue when audio is unavailable.
 */
export async function prepareBrowserAudioStream(sessionId: string): Promise<void> {
  if (!streamEnabled() || !audioEnabled()) return;
  try {
    await prepareAudio(resolveChannel(sessionId));
  } catch {
    // Audio is an optional live-view capability.
  }
}

export async function shutdownBrowserGateway(): Promise<void> {
  for (const channel of [...channels.values()]) disposeChannel(channel);
  const server = httpServer;
  httpServer = undefined;
  endpoint = undefined;
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Exported for tests: host speaker output stays muted unless opted in. */
export function browserAudioEnabled(): boolean {
  return enabledEnv('FLUJO_BROWSER_AUDIO');
}

/** Exported for tests: whether the page audio tap streams to the app. */
export function browserAudioStreamEnabled(): boolean {
  return audioEnabled();
}
