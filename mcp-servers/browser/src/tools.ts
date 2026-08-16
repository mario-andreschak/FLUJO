import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Page } from 'patchright';
import {
  BrowserMcpError,
  assertNavigationAllowed,
  browserDiagnostics,
  browserExtensions,
  closeSession,
  createCaptureContext,
  defaultViewport,
  failureCategoryForCode,
  getSession,
  openSession,
  publicPageState,
  resetNavigationCounter,
  runCancellable,
  timeoutMs,
  writeScreenshotArtifact,
  type BrowserErrorCode,
  type BrowserFailureCategory,
  type BrowserSession,
} from './runtime.js';
import { BROWSER_APP_URI } from './resources.js';
import {
  captureDeterministicPng,
  captureRegionPng,
  evaluateElementMetrics,
  finiteParameter,
  navigateCaptureSource,
  normalizeResolution,
  resolutionFallbacks,
  resolveCaptureSource,
  sha256Hex,
  writeCaptureArtifact,
} from './capture.js';
import { recordingStatus, startRecording, stopRecording } from './recording.js';
import { prepareBrowserAudioStream } from './gateway.js';

const MAX_TEXT_CHARS = 50_000;
const MAX_SELECTOR_CHARS = 2_000;
const MAX_SCREENSHOT_BYTES = 5_000_000;
const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const INTERACTION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
const APP_META = {
  ui: {
    resourceUri: BROWSER_APP_URI,
    visibility: ['model', 'app'],
  },
};

const SESSION_PROPERTY = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,64}$',
  description: 'Optional browser session identifier. When omitted, the most recently used live session is reused.',
} as const;
const TIMEOUT_PROPERTY = {
  type: 'number',
  minimum: 1000,
  maximum: 60000,
  description: 'Operation timeout in milliseconds (default 30000).',
} as const;

export function browserToolDefinitions(): Tool[] {
  return [
    {
      name: 'browser_open',
      description: 'Open a new browser session, or open/reuse the exact sessionId supplied. url may be remote, localhost, a bare hostname, or a local file path.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { ...SESSION_PROPERTY, description: 'Optional stable id. Omit it to create a fresh isolated session; supply it to open or reuse that exact session.' },
          url: { type: 'string', description: 'Optional URL, bare hostname, localhost address, or local file path.' },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_navigate',
      description: 'Navigate the active browser to a remote URL, bare hostname, localhost address, or local file path. Only executable/non-browser URL schemes are rejected.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, url: { type: 'string' }, timeoutMs: TIMEOUT_PROPERTY },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_back',
      description: 'Navigate an existing browser session backward in its page history.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_forward',
      description: 'Navigate an existing browser session forward in its page history.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_reload',
      description: 'Reload the current page in an existing browser session.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_snapshot',
      description: 'Read the current page title, URL, and bounded visible body text without exposing cookies or storage.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_click',
      description: 'Click either the first element matching a selector or viewport coordinates in an existing browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          selector: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS },
          x: { type: 'number', minimum: 0, description: 'Viewport x coordinate in CSS pixels.' },
          y: { type: 'number', minimum: 0, description: 'Viewport y coordinate in CSS pixels.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
          clickCount: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        anyOf: [{ required: ['selector'] }, { required: ['x', 'y'] }],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_type',
      description: 'Fill an element matching a selector, or type into the currently focused page element; optionally press Enter afterward.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          selector: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS },
          text: { type: 'string', maxLength: 100000 },
          submit: { type: 'boolean', default: false },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_press',
      description: 'Press a keyboard key or shortcut in the currently focused page element.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          key: { type: 'string', minLength: 1, maxLength: 100, description: 'Patchright key name or shortcut, such as Enter, Tab, ArrowDown, or Control+A.' },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['key'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the current page by viewport-relative pixel deltas.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          deltaX: { type: 'number', minimum: -100000, maximum: 100000, default: 0 },
          deltaY: { type: 'number', minimum: -100000, maximum: 100000, default: 0 },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        anyOf: [{ required: ['deltaX'] }, { required: ['deltaY'] }],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot, persist it under the FLUJO data directory, and report its full absolute file path.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          fullPage: { type: 'boolean', default: false },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_capture_page',
      description: 'Capture a page as PNG. source may be a remote URL, localhost URL, local path, file:// URL, or inline HTML; omit source to capture the active session. Resolution presets such as 720p, 1080p, and 4k are accepted and safely adjusted when necessary.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'URL, localhost address, local path, file:// URL, or inline HTML. Omit to capture the active session.' },
          sessionId: SESSION_PROPERTY,
          resolution: { type: 'string', description: 'Preset or WIDTHxHEIGHT, for example 720p, 1080p, 4k, or 1600x900.' },
          selector: { type: 'string', description: 'Optional CSS selector to capture only one element.' },
          fullPage: { type: 'boolean', default: false },
          outputPath: { type: 'string', description: 'Optional destination path, confined to the FLUJO data directory.' },
        },
        // Legacy url/html/filePath/width/height/etc. arguments remain accepted
        // by the handler without cluttering the model-facing contract.
        additionalProperties: true,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_capture_element_metrics',
      description: 'Query per-selector layout metrics (bounding box, computed style, overflow/clipping flags, viewport visibility) without taking a screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          selectors: { type: 'array', items: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS }, minItems: 1, maxItems: 50 },
          sessionId: SESSION_PROPERTY,
          source: { type: 'string', description: 'Optional URL or local path to load before measuring.' },
        },
        required: ['selectors'],
        additionalProperties: true,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_capture_region',
      description: 'Capture a rectangular page region as PNG. source accepts remote URLs, localhost, or local paths; omit it to use the active session. Missing or out-of-range coordinates are safely normalized.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Optional URL, localhost address, or local path.' },
          sessionId: SESSION_PROPERTY,
          region: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
            description: 'Region in CSS pixels. Defaults to the visible viewport.',
          },
          outputPath: { type: 'string', description: 'Optional destination path, confined to the FLUJO data directory.' },
        },
        additionalProperties: true,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_record_start',
      description: 'Start a sturdy browser recording and immediately return a sessionId. Optionally load source first and auto-stop after durationMs. Unsupported resolutions fall back automatically and are reported in warnings/effectiveResolution.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Optional URL, localhost address, local path, or inline HTML to load before returning.' },
          resolution: { type: 'string', description: 'Preset or WIDTHxHEIGHT, for example 720p, 1080p, 4k, or 1600x900.' },
          audio: { type: 'boolean', default: true, description: 'Capture page audio into a WAV sidecar (and mux it in if ffmpeg is available).' },
          durationMs: { type: 'number', description: 'Optional auto-stop delay. The start call still returns immediately; retrieve the artifact with stop or status.' },
          outputPath: { type: 'string', description: 'Optional destination path for the finished artifact, confined to the FLUJO data directory.' },
        },
        additionalProperties: true,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_record_stop',
      description: 'Stop and finalize a recording, or retrieve one that just auto-stopped. Returns usable artifact paths, recovery warnings, and the video itself as MCP media when small enough.',
      inputSchema: {
        type: 'object',
        properties: {
          recordingId: { ...SESSION_PROPERTY, description: 'Recording id returned by browser_record_start (same as its sessionId). Omit when exactly one recording is running.' },
          sessionId: SESSION_PROPERTY,
          outputPath: { type: 'string', description: 'Optional destination path for the finished artifact, confined to the FLUJO data directory.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: APP_META,
    },
    {
      name: 'browser_record_status',
      description: 'Report recording, finalizing, or recently completed state. Completed status includes the artifact and embeds the video as MCP media when small enough.',
      inputSchema: {
        type: 'object',
        properties: {
          recordingId: SESSION_PROPERTY,
          sessionId: SESSION_PROPERTY,
        },
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_diagnostics',
      description: 'Report configured/actual browser mode, channel, headless state, persistence, locale, service-worker policy, and the active page fingerprint without opening a destination site.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY },
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_extensions',
      description: 'List extensions installed in FLUJO\'s dedicated trusted Chrome profile, explicitly configured unpacked-extension directories, and currently active extension targets. Never reads the personal Chrome profile.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_close',
      description: 'Close the session tab. Sandbox state is discarded; trusted-mode cookies and profile state remain in the dedicated persistent profile.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: APP_META,
    },
  ];
}

function success(data: Record<string, unknown>, extraContent: CallToolResult['content'] = []): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }, ...extraContent],
    structuredContent: data,
  };
}

function failure(
  code: BrowserErrorCode,
  message: string,
  category?: BrowserFailureCategory,
): CallToolResult {
  const data = { success: false, error: { code, category: category ?? failureCategoryForCode(code), message } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

async function recordingResult(data: Record<string, unknown>): Promise<CallToolResult> {
  if (data.success === false) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }
  const outputPath = typeof data.outputPath === 'string' ? data.outputPath : undefined;
  if (!outputPath || data.status !== 'stopped') return success(data);
  const stat = await fs.stat(outputPath).catch(() => undefined);
  const maxBytesRaw = Number(process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES);
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.trunc(maxBytesRaw) : 16 * 1024 * 1024;
  if (!stat?.isFile() || stat.size <= 0) return success(data);
  if (stat.size > maxBytes) {
    const warnings = Array.isArray(data.warnings) ? [...data.warnings] : [];
    warnings.push(`The ${stat.size}-byte video is available at outputPath but was not inlined into MCP because it exceeds the ${maxBytes}-byte transport limit.`);
    return success({ ...data, warnings });
  }
  const mimeType = pathToFileURL(outputPath).pathname.toLowerCase().endsWith('.mp4')
    ? 'video/mp4'
    : (pathToFileURL(outputPath).pathname.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/webm');
  const blob = (await fs.readFile(outputPath)).toString('base64');
  return success(data, [{
    type: 'resource',
    resource: {
      uri: pathToFileURL(outputPath).href,
      mimeType,
      blob,
    },
  }]);
}

function normalizedError(error: unknown): BrowserMcpError {
  if (error instanceof BrowserMcpError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'TimeoutError' || /timeout/i.test(name)) {
    return new BrowserMcpError('TIMEOUT', 'The browser operation timed out.');
  }
  if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message)) {
    return new BrowserMcpError('NAVIGATION_BLOCKED', 'The navigation was blocked by browser policy.');
  }
  if (/Target page, context or browser has been closed|browser has disconnected/i.test(message)) {
    return new BrowserMcpError('BROWSER_UNAVAILABLE', 'The browser process became unavailable; open a new session.');
  }
  const useful = message.trim().replace(/\s+/g, ' ').slice(0, 800);
  return new BrowserMcpError('UNEXPECTED', useful ? `The browser operation failed: ${useful}` : 'The browser operation failed.');
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string, maxLength = 100_000): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BrowserMcpError('INVALID_ARGUMENT', `${key} must be a non-empty string no longer than ${maxLength} characters.`);
  }
  return value;
}

function finiteNumberArg(args: Record<string, unknown>, key: string, fallback?: number): number {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', `${key} must be a finite number.`);
  }
  return parsed;
}

type CapturePageHandle = { page: Page; close: () => Promise<void> };

function hasCaptureSource(args: Record<string, unknown>): boolean {
  return ['source', 'url', 'html', 'filePath'].some((key) => typeof args[key] === 'string' && String(args[key]).trim().length > 0);
}

async function optionalCaptureSource(args: Record<string, unknown>) {
  if (!hasCaptureSource(args)) return undefined;
  return resolveCaptureSource({
    source: args.source,
    url: typeof args.url === 'string' ? args.url : undefined,
    html: typeof args.html === 'string' ? args.html : undefined,
    filePath: typeof args.filePath === 'string' ? args.filePath : undefined,
    allowLocal: args.allowLocal === true,
  });
}

/** Resolve the page a capture tool should operate on: an existing session's page, the active page, or an ephemeral context. */
async function acquireCapturePage(
  args: Record<string, unknown>,
  signal: AbortSignal,
  viewport: { width: number; height: number; deviceScaleFactor?: number; colorScheme?: 'light' | 'dark' },
  preferActive: boolean,
): Promise<CapturePageHandle> {
  if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
    const session = getSession(args.sessionId);
    return { page: session.page, close: async () => undefined };
  }
  if (preferActive) {
    try {
      const session = getSession(undefined);
      return { page: session.page, close: async () => undefined };
    } catch (error) {
      if (!(error instanceof BrowserMcpError) || error.code !== 'NOT_FOUND') throw error;
    }
  }
  const { context, page } = await createCaptureContext(signal, viewport);
  return { page, close: () => context.close().catch(() => undefined) };
}

type CaptureToolResult = { data: Record<string, unknown>; image: { data: string; mimeType: string } };

async function captureRegionOrPage(
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeout: number,
): Promise<CaptureToolResult> {
  const resolution = normalizeResolution(args.resolution, args.width, args.height, {
    defaultValue: { width: 1920, height: 1080 },
    minWidth: 320,
    minHeight: 240,
    maxWidth: 3840,
    maxHeight: 2160,
  });
  const rawScale = finiteParameter(args.deviceScaleFactor, 1);
  const deviceScaleFactor = Math.min(3, Math.max(1, rawScale));
  if (deviceScaleFactor !== rawScale) resolution.warnings.push(`deviceScaleFactor was adjusted to ${deviceScaleFactor}.`);
  const colorScheme = args.colorScheme === 'dark' ? 'dark' : 'light';
  const fullPage = args.fullPage === true;
  let clipSelector = typeof args.selector === 'string' && args.selector.trim()
    ? args.selector.trim()
    : (typeof args.clipSelector === 'string' && args.clipSelector.trim() ? args.clipSelector.trim() : undefined);
  if (clipSelector && clipSelector.length > MAX_SELECTOR_CHARS) {
    resolution.warnings.push(`selector was shortened to ${MAX_SELECTOR_CHARS} characters.`);
    clipSelector = clipSelector.slice(0, MAX_SELECTOR_CHARS);
  }
  const waitFor = typeof args.waitFor === 'string' && args.waitFor.length > 0 ? args.waitFor : undefined;
  const source = await optionalCaptureSource(args);
  const warnings = [...resolution.warnings, ...(source?.warnings ?? [])];
  const attempts: string[] = [];
  let lastError: unknown;

  for (const candidate of resolutionFallbacks(resolution.effective).filter(({ width, height }) => width <= 3840 && height <= 2160)) {
    const handle = await acquireCapturePage(
      args,
      signal,
      { ...candidate, deviceScaleFactor, colorScheme },
      !source,
    );
    try {
      if (resolution.explicit && typeof handle.page.setViewportSize === 'function') {
        await handle.page.setViewportSize(candidate).catch(() => undefined);
      }
      const { png, colorType } = await captureDeterministicPng(
        handle.page,
        source,
        { fullPage, clipSelector, waitFor, timeoutMs: timeout },
      );
      const filePath = await writeCaptureArtifact(
        typeof args.outputPath === 'string' ? args.outputPath : undefined,
        ['captures', `${randomUUID()}.png`],
        png,
      );
      if (attempts.length > 0) warnings.push(`Capture recovered at ${candidate.width}x${candidate.height} after ${attempts.length} failed attempt(s).`);
      return {
        data: {
          success: true,
          path: filePath,
          requestedResolution: resolution.requested,
          effectiveResolution: candidate,
          width: candidate.width,
          height: candidate.height,
          deviceScaleFactor,
          colorType,
          fullPage,
          selector: clipSelector ?? null,
          bytes: png.length,
          sha256: sha256Hex(png),
          mimeType: 'image/png',
          warnings,
          ...(attempts.length ? { attempts } : {}),
        },
        image: { data: png.toString('base64'), mimeType: 'image/png' },
      };
    } catch (error) {
      lastError = error;
      attempts.push(`${candidate.width}x${candidate.height}: ${error instanceof Error ? error.message : 'capture failed'}`);
    } finally {
      await handle.close();
    }
  }
  throw new BrowserMcpError(
    'UNEXPECTED',
    `Capture failed after safe resolution fallbacks. ${attempts.join(' | ') || (lastError instanceof Error ? lastError.message : '')}`,
  );
}

async function captureRegionTool(
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeout: number,
): Promise<CaptureToolResult> {
  const viewport = defaultViewport();
  const region = args.region && typeof args.region === 'object' && !Array.isArray(args.region)
    ? args.region as Record<string, unknown>
    : args;
  const rawX = finiteParameter(region.x, 0);
  const rawY = finiteParameter(region.y, 0);
  const x = Math.min(3839, Math.max(0, Math.round(rawX)));
  const y = Math.min(2159, Math.max(0, Math.round(rawY)));
  const rawWidth = finiteParameter(region.width, Math.max(1, viewport.width - x));
  const rawHeight = finiteParameter(region.height, Math.max(1, viewport.height - y));
  const width = Math.min(3840 - x, Math.max(1, Math.round(rawWidth)));
  const height = Math.min(2160 - y, Math.max(1, Math.round(rawHeight)));
  const warnings: string[] = [];
  if (x !== rawX || y !== rawY || width !== rawWidth || height !== rawHeight) {
    warnings.push(`Region was normalized to x=${x}, y=${y}, width=${width}, height=${height}.`);
  }
  const source = await optionalCaptureSource(args);
  warnings.push(...(source?.warnings ?? []));
  const { page, close } = await acquireCapturePage(args, signal, {
    width: Math.min(3840, Math.max(viewport.width, x + width)),
    height: Math.min(2160, Math.max(viewport.height, y + height)),
  }, !source);
  try {
    const { png, colorType } = await captureRegionPng(page, source, { x, y, width, height }, timeout);
    const filePath = await writeCaptureArtifact(
      typeof args.outputPath === 'string' ? args.outputPath : undefined,
      ['regions', `${randomUUID()}.png`],
      png,
    );
    return {
      data: {
        success: true,
        path: filePath,
        x,
        y,
        width,
        height,
        colorType,
        bytes: png.length,
        sha256: sha256Hex(png),
        mimeType: 'image/png',
        warnings,
      },
      image: { data: png.toString('base64'), mimeType: 'image/png' },
    };
  } finally {
    await close();
  }
}

async function captureElementMetricsTool(
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeout: number,
): Promise<Record<string, unknown>> {
  const rawSelectors = args.selectors;
  if (!Array.isArray(rawSelectors) || rawSelectors.length === 0) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Provide a non-empty "selectors" array.');
  }
  const selectors = rawSelectors
    .map((value) => String(value))
    .filter((value) => value.length > 0 && value.length <= MAX_SELECTOR_CHARS);
  if (selectors.length === 0) {
    throw new BrowserMcpError('INVALID_ARGUMENT', `Each selector must be 1-${MAX_SELECTOR_CHARS} characters.`);
  }
  const hasSource = hasCaptureSource(args);

  if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
    const session = getSession(args.sessionId);
    if (hasSource) {
      const source = await optionalCaptureSource(args);
      if (!source) throw new BrowserMcpError('INVALID_ARGUMENT', 'Could not resolve the supplied source.');
      await navigateCaptureSource(session.page, source, timeout);
    }
    return { success: true, metrics: await evaluateElementMetrics(session.page, selectors) };
  }

  if (hasSource) {
    const source = await optionalCaptureSource(args);
    if (!source) throw new BrowserMcpError('INVALID_ARGUMENT', 'Could not resolve the supplied source.');
    const { context, page } = await createCaptureContext(signal, defaultViewport());
    try {
      await navigateCaptureSource(page, source, timeout);
      return { success: true, metrics: await evaluateElementMetrics(page, selectors), warnings: source.warnings };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  const session = getSession(undefined);
  return { success: true, metrics: await evaluateElementMetrics(session.page, selectors) };
}

type NavigationResponse = Awaited<ReturnType<Page['goto']>>;

function siteBlockClassification(
  status: number | undefined,
  title: string,
  text: string,
  url: string,
): Record<string, unknown> | undefined {
  const challengeText = `${title}\n${text.slice(0, 4_000)}`;
  const challengePattern = /just a moment|verify (?:that )?you are human|unusual traffic|ungewöhnlichen datenverkehr|tr[aá]fico inusual|trafic inhabituel|attention required|access denied|captcha|security check|request unsuccessful/i;
  const challengeUrlPattern = /\/(?:sorry|captcha)(?:\/|$)|\/challenge(?:\/|$)|\/cdn-cgi\/challenge-platform(?:\/|$)/i;
  if (status !== undefined && [401, 403, 407, 429, 451].includes(status)) {
    return {
      classification: 'site',
      blocked: true,
      status,
      reason: `The destination returned HTTP ${status}; this was not blocked by FLUJO policy.`,
    };
  }
  if (challengeUrlPattern.test(url) || challengePattern.test(challengeText)) {
    return {
      classification: 'site',
      blocked: true,
      ...(status !== undefined ? { status } : {}),
      reason: 'The destination rendered an anti-bot, CAPTCHA, or access-denied challenge; this was not blocked by FLUJO policy.',
    };
  }
  if (status !== undefined) {
    return { classification: 'none', blocked: false, status };
  }
  return undefined;
}

async function pageState(
  session: BrowserSession,
  timeout: number,
  response?: NavigationResponse,
): Promise<Record<string, unknown>> {
  const [title, bodyText] = await Promise.all([
    session.page.title(),
    session.page.locator('body').innerText({ timeout }).catch(() => ''),
  ]);
  const text = bodyText.length > MAX_TEXT_CHARS
    ? `${bodyText.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`
    : bodyText;
  const navigation = siteBlockClassification(response?.status(), title, text, session.page.url());
  return {
    success: true,
    ...publicPageState(session),
    title,
    text,
    ...(navigation ? { navigation } : {}),
  };
}

async function navigate(session: BrowserSession, rawUrl: string, timeout: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = await assertNavigationAllowed(rawUrl);
  // Install the main-world audio hook before page.goto: once a page has created
  // its AudioContext or fired a media play event, it cannot be intercepted
  // retroactively.
  await prepareBrowserAudioStream(session.id);
  resetNavigationCounter(session);
  return runCancellable(session, signal, async () => {
    try {
      const response = await session.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
      return pageState(session, timeout, response);
    } catch (error) {
      if (session.navigationBlocked) {
        throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The navigation or one of its redirects was blocked by browser policy.');
      }
      throw error;
    }
  });
}

export async function browserCallTool(
  name: string,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const args = objectArgs(rawArgs);
    if (name === 'browser_open') {
      const session = await openSession(args.sessionId, signal);
      const timeout = timeoutMs(args.timeoutMs);
      const data = typeof args.url === 'string' && args.url.length > 0
        ? await navigate(session, args.url, timeout, signal)
        : { success: true, ...publicPageState(session) };
      // Keep the session identity in the structured result at the process
      // boundary; callers must not scrape the human-readable text payload.
      return success({ ...data, sessionId: session.id });
    }
    if (name === 'browser_close') {
      let sessionId: string;
      if (args.sessionId === undefined || args.sessionId === '') {
        try {
          sessionId = getSession(undefined).id;
        } catch (error) {
          if (error instanceof BrowserMcpError && error.code === 'NOT_FOUND') {
            return success({ success: true, sessionId: null, closed: false });
          }
          throw error;
        }
      } else {
        sessionId = stringArg(args, 'sessionId', 64);
      }
      const closed = await closeSession(sessionId);
      return success({ success: true, sessionId, closed });
    }
    if (name === 'browser_diagnostics') {
      let session: BrowserSession | undefined;
      if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
        session = getSession(args.sessionId);
      } else {
        try {
          session = getSession(undefined);
        } catch (error) {
          if (!(error instanceof BrowserMcpError) || error.code !== 'NOT_FOUND') throw error;
        }
      }
      return success(await browserDiagnostics(session));
    }
    if (name === 'browser_extensions') {
      return success(await browserExtensions());
    }

    const timeout = timeoutMs(args.timeoutMs);

    if (name === 'browser_capture_page') {
      const result = await captureRegionOrPage(args, signal, timeout);
      return success(result.data, [{ type: 'image', data: result.image.data, mimeType: result.image.mimeType }]);
    }
    if (name === 'browser_capture_region') {
      const result = await captureRegionTool(args, signal, timeout);
      return success(result.data, [{ type: 'image', data: result.image.data, mimeType: result.image.mimeType }]);
    }
    if (name === 'browser_capture_element_metrics') {
      return success(await captureElementMetricsTool(args, signal, timeout));
    }
    if (name === 'browser_record_start') {
      return recordingResult(await startRecording(
        {
          source: args.source,
          resolution: args.resolution,
          width: args.width,
          height: args.height,
          audio: args.audio,
          durationMs: args.durationMs,
          outputPath: args.outputPath,
          url: args.url,
          html: args.html,
          filePath: args.filePath,
          timeoutMs: args.timeoutMs,
        },
        signal,
      ));
    }
    if (name === 'browser_record_stop') {
      return recordingResult(await stopRecording({
        recordingId: args.recordingId,
        sessionId: args.sessionId,
        outputPath: args.outputPath,
      }));
    }
    if (name === 'browser_record_status') {
      return recordingResult(recordingStatus({ recordingId: args.recordingId, sessionId: args.sessionId }));
    }

    const session = getSession(args.sessionId);
    if (name === 'browser_navigate') {
      return success(await navigate(session, stringArg(args, 'url', 8_192), timeout, signal));
    }
    if (name === 'browser_back' || name === 'browser_forward' || name === 'browser_reload') {
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        if (name === 'browser_back') {
          await session.page.goBack({ waitUntil: 'domcontentloaded', timeout });
        } else if (name === 'browser_forward') {
          await session.page.goForward({ waitUntil: 'domcontentloaded', timeout });
        } else {
          await session.page.reload({ waitUntil: 'domcontentloaded', timeout });
        }
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The history navigation was blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_snapshot') {
      return success(await runCancellable(session, signal, () => pageState(session, timeout)));
    }
    if (name === 'browser_click') {
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        if (args.button !== undefined && !['left', 'right', 'middle'].includes(String(args.button))) {
          throw new BrowserMcpError('INVALID_ARGUMENT', 'button must be left, right, or middle.');
        }
        const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
        const clickCount = finiteNumberArg(args, 'clickCount', 1);
        if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
          throw new BrowserMcpError('INVALID_ARGUMENT', 'clickCount must be an integer from 1 to 3.');
        }
        if (typeof args.selector === 'string' && args.selector.length > 0) {
          if (args.selector.length > MAX_SELECTOR_CHARS) {
            throw new BrowserMcpError('INVALID_ARGUMENT', `selector must be no longer than ${MAX_SELECTOR_CHARS} characters.`);
          }
          await session.page.locator(args.selector).first().click({ timeout, button, clickCount });
        } else {
          const x = finiteNumberArg(args, 'x');
          const y = finiteNumberArg(args, 'y');
          const viewport = session.page.viewportSize();
          if (x < 0 || y < 0 || (viewport && (x >= viewport.width || y >= viewport.height))) {
            throw new BrowserMcpError('INVALID_ARGUMENT', 'Click coordinates must be inside the current viewport.');
          }
          await session.page.mouse.click(x, y, { button, clickCount });
        }
        await session.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_type') {
      const text = args.text;
      if (typeof text !== 'string' || text.length > 100_000) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'text must be a string no longer than 100000 characters.');
      }
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        if (typeof args.selector === 'string' && args.selector.length > 0) {
          if (args.selector.length > MAX_SELECTOR_CHARS) {
            throw new BrowserMcpError('INVALID_ARGUMENT', `selector must be no longer than ${MAX_SELECTOR_CHARS} characters.`);
          }
          const locator = session.page.locator(args.selector).first();
          await locator.fill(text, { timeout });
          if (args.submit === true) await locator.press('Enter', { timeout });
        } else {
          await session.page.keyboard.insertText(text);
          if (args.submit === true) await session.page.keyboard.press('Enter');
        }
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_press') {
      const key = stringArg(args, 'key', 100);
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        await session.page.keyboard.press(key);
        await session.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The keyboard interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_scroll') {
      const deltaX = finiteNumberArg(args, 'deltaX', 0);
      const deltaY = finiteNumberArg(args, 'deltaY', 0);
      if (Math.abs(deltaX) > 100_000 || Math.abs(deltaY) > 100_000) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'Scroll deltas must be between -100000 and 100000.');
      }
      const data = await runCancellable(session, signal, async () => {
        await session.page.mouse.wheel(deltaX, deltaY);
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_screenshot') {
      const fullPage = args.fullPage === true;
      const png = await runCancellable(session, signal, () => session.page.screenshot({
        type: 'png',
        fullPage,
        timeout,
      }));
      if (png.length > MAX_SCREENSHOT_BYTES) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'The screenshot exceeded the 5 MB artifact limit.');
      }
      const filePath = await writeScreenshotArtifact(session.id, fullPage, png);
      const data = {
        success: true,
        ...publicPageState(session),
        path: filePath,
        mimeType: 'image/png',
        bytes: png.length,
        viewport: session.page.viewportSize(),
      };
      return success(data, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    }
    return failure('NOT_FOUND', `Unknown browser tool: ${name}`);
  } catch (error) {
    const normalized = normalizedError(error);
    return failure(normalized.code, normalized.message, normalized.category);
  }
}
