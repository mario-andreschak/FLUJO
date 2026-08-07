/**
 * Deterministic still capture for the browser MCP server (#366).
 *
 * Kept out of `tools.ts`/`runtime.ts` to keep those under control, per the
 * plan. Everything here operates on a `Page` handed in by the caller — either
 * an ephemeral capture context (`createCaptureContext()` in `runtime.ts`) or
 * an existing session's page — and never owns session lifecycle itself.
 *
 * Local-source gating (`assertLocalCaptureAllowed`) is the narrow, explicit
 * bypass mentioned in the plan: it does not touch `assertNavigationAllowed()`,
 * so ordinary `browser_open`/`browser_navigate` behaviour is unchanged. Four
 * independent gates must all hold before a `file://` / localhost / private
 * host is captured:
 *  1. `allowLocal === true` on the call;
 *  2. `FLUJO_BROWSER_ALLOW_LOCAL_CAPTURE` is truthy (default off);
 *  3. the resolved realpath satisfies `isInside()` against the FLUJO data
 *     directory or an entry in `FLUJO_BROWSER_LOCAL_CAPTURE_ROOTS`;
 *  4. everything else still goes through the ordinary `assertNavigationAllowed()`.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ElementHandle, Page } from 'patchright';
import { BrowserMcpError, assertNavigationAllowed, enabledEnv } from './runtime.js';

/**
 * Local `getDataDir()`/`isInside()` — deliberately not imported from
 * `mcp-servers/shared`: the browser package resolves `FLUJO_DATA_DIR` inline
 * everywhere else (see `runtime.ts`'s `screenshotRoot()`), and does not carry
 * the `@flujo-ai/mcp-shared` workspace dependency the other packages use.
 */
export function getDataDir(): string {
  return path.resolve(process.env.FLUJO_DATA_DIR?.trim() || process.cwd());
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const PNG_SIGNATURE = '89504e470d0a1a0a';
/** Byte offset of the IHDR color-type field: 8 (signature) + 4 (length) + 4 ("IHDR") + 4 (width) + 4 (height) + 1 (bit depth). */
const PNG_COLOR_TYPE_OFFSET = 25;

export type CaptureSource =
  | { kind: 'html'; html: string }
  | { kind: 'url'; url: string };

/** Assert a single, stable PNG color type and return it. Never silently accepts a malformed image. */
export function pngColorType(png: Buffer): number {
  if (png.length <= PNG_COLOR_TYPE_OFFSET || png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new BrowserMcpError('UNEXPECTED', 'The captured image is not a valid PNG.');
  }
  return png.readUInt8(PNG_COLOR_TYPE_OFFSET);
}

async function realpathIfExists(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function localCaptureRoots(): string[] {
  const roots = [getDataDir()];
  const raw = process.env.FLUJO_BROWSER_LOCAL_CAPTURE_ROOTS?.trim();
  if (raw) {
    for (const entry of raw.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (trimmed) roots.push(path.resolve(trimmed));
    }
  }
  return roots;
}

function isLocalOrPrivateOrigin(url: URL): boolean {
  if (url.protocol === 'file:') return true;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    || hostname.endsWith('.localhost') || hostname.endsWith('.local');
}

/** Gates 1-3 of the local-capture ladder; gate 4 is `assertNavigationAllowed()` itself. */
export async function assertLocalCaptureAllowed(resolvedPath: string, allowLocal: boolean): Promise<void> {
  if (!allowLocal) {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'Local file/localhost capture requires allowLocal=true.');
  }
  if (!enabledEnv('FLUJO_BROWSER_ALLOW_LOCAL_CAPTURE')) {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'Local capture is disabled by policy (set FLUJO_BROWSER_ALLOW_LOCAL_CAPTURE=1 to enable).');
  }
  const real = await realpathIfExists(resolvedPath);
  const roots = localCaptureRoots();
  if (!roots.some((root) => isInside(root, real))) {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The local path is outside the allowed capture roots.');
  }
}

/**
 * Resolve exactly one of `url` / `html` / `filePath` into a `CaptureSource`,
 * applying local-source gating for `file://` and localhost/private-host
 * inputs and the ordinary `assertNavigationAllowed()` gate for everything
 * else.
 */
export async function resolveCaptureSource(args: {
  url?: string;
  html?: string;
  filePath?: string;
  allowLocal?: boolean;
}): Promise<CaptureSource> {
  const provided = [args.url, args.html, args.filePath].filter((value) => typeof value === 'string' && value.length > 0);
  if (provided.length !== 1) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Provide exactly one of url, html, or filePath.');
  }
  if (typeof args.html === 'string') {
    return { kind: 'html', html: args.html };
  }
  const allowLocal = args.allowLocal === true;
  if (typeof args.filePath === 'string') {
    const resolved = path.resolve(args.filePath);
    await assertLocalCaptureAllowed(resolved, allowLocal);
    return { kind: 'url', url: pathToFileURL(resolved).href };
  }
  const raw = args.url as string;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The URL is malformed.');
  }
  if (parsed.protocol === 'file:') {
    await assertLocalCaptureAllowed(fileURLToPath(parsed), allowLocal);
    return { kind: 'url', url: parsed.href };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserMcpError('NAVIGATION_BLOCKED', 'Only HTTP, HTTPS, and file:// URLs are allowed.');
  }
  if (isLocalOrPrivateOrigin(parsed)) {
    await assertLocalCaptureAllowed(raw, allowLocal);
    return { kind: 'url', url: parsed.href };
  }
  // Gate 4: ordinary navigation policy, byte-for-byte unchanged, for anything
  // that is not a local/private destination.
  const allowedUrl = await assertNavigationAllowed(raw);
  return { kind: 'url', url: allowedUrl.href };
}

function looksLikeJsPredicate(expression: string): boolean {
  return /[(){}=]/.test(expression) || /^\s*function\b/.test(expression) || expression.includes('=>');
}

export type CapturePageOptions = {
  fullPage: boolean;
  clipSelector?: string;
  waitFor?: string;
  timeoutMs: number;
};

/**
 * Determinism ladder: navigate → `waitForLoadState('load')` →
 * `document.fonts.ready` → optional `waitFor` (selector or JS predicate,
 * boolean-coerced and discarded — never returned to the caller, per D4) →
 * screenshot with animations disabled.
 */
export async function captureDeterministicPng(
  page: Page,
  source: CaptureSource,
  options: CapturePageOptions,
): Promise<{ png: Buffer; colorType: number }> {
  const timeout = options.timeoutMs;
  if (source.kind === 'html') {
    await page.setContent(source.html, { waitUntil: 'load', timeout });
  } else {
    await page.goto(source.url, { waitUntil: 'load', timeout });
  }
  await page.waitForLoadState('load', { timeout }).catch(() => undefined);
  // No `dom` lib in this workspace's tsconfig, so the fonts-ready wait is a
  // fixed string body rather than a typed arrow function (same rationale as
  // ELEMENT_METRICS_SCRIPT below).
  await page.evaluate('(document.fonts && document.fonts.ready) || Promise.resolve()').catch(() => undefined);

  if (options.waitFor) {
    if (looksLikeJsPredicate(options.waitFor)) {
      // The predicate's return value is intentionally discarded: this waits
      // for a boolean-truthy condition and never leaks arbitrary evaluation
      // results back to the caller (D4 — no general JS-evaluate tool).
      await page.waitForFunction(options.waitFor, undefined, { timeout });
    } else {
      await page.waitForSelector(options.waitFor, { timeout });
    }
  }

  let handle: ElementHandle | null = null;
  try {
    let png: Buffer;
    if (options.clipSelector) {
      handle = await page.waitForSelector(options.clipSelector, { timeout });
      if (!handle) throw new BrowserMcpError('NOT_FOUND', 'clipSelector did not match any element.');
      await handle.scrollIntoViewIfNeeded({ timeout }).catch(() => undefined);
      png = await handle.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css', timeout });
    } else {
      png = await page.screenshot({
        type: 'png',
        fullPage: options.fullPage,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout,
      });
    }
    return { png, colorType: pngColorType(png) };
  } finally {
    await handle?.dispose().catch(() => undefined);
  }
}

/** Navigate/render a resolved source without capturing (used by `browser_capture_element_metrics`). */
export async function navigateCaptureSource(page: Page, source: CaptureSource, timeoutMs: number): Promise<void> {
  if (source.kind === 'html') {
    await page.setContent(source.html, { waitUntil: 'load', timeout: timeoutMs });
  } else {
    await page.goto(source.url, { waitUntil: 'load', timeout: timeoutMs });
  }
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
}

export type CaptureRegion = { x: number; y: number; width: number; height: number };

/** Region capture is a clipped `page.screenshot()`, not a manual pixel crop, so DPR/scroll never drift the result. */
export async function captureRegionPng(
  page: Page,
  source: CaptureSource,
  region: CaptureRegion,
  timeoutMs: number,
): Promise<{ png: Buffer; colorType: number }> {
  if (source.kind === 'html') {
    await page.setContent(source.html, { waitUntil: 'load', timeout: timeoutMs });
  } else {
    await page.goto(source.url, { waitUntil: 'load', timeout: timeoutMs });
  }
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
  const png = await page.screenshot({
    type: 'png',
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    clip: region,
    timeout: timeoutMs,
  });
  return { png, colorType: pngColorType(png) };
}

export type ElementMetrics = {
  selector: string;
  found: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number };
  clientRect?: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  scrollWidth?: number;
  scrollHeight?: number;
  isVisible?: boolean;
  isInViewport?: boolean;
  overflowX?: string;
  overflowY?: string;
  textOverflow?: boolean;
  actionSafe?: boolean;
  computed?: Record<string, string>;
};

/**
 * A single, fixed, non-parameterised `page.evaluate` script body, kept as a
 * string (this file's `tsconfig.json` has no `dom` lib, and the script only
 * ever runs inside the page, never in this Node process). Selectors are
 * passed as *data* arguments only — never string-concatenated into code — so
 * this cannot become a general JS-evaluate primitive (D4).
 */
const ELEMENT_METRICS_SCRIPT = `(function(selectors){
  function overflowClass(value, scrollSize, clientSize){
    if (value === "visible") return "visible";
    if (scrollSize > clientSize) return value === "scroll" ? "scroll" : "clipped";
    return value;
  }
  return selectors.map(function(selector){
    var el = document.querySelector(selector);
    if (!el) return { selector: selector, found: false };
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    var viewportW = window.innerWidth, viewportH = window.innerHeight;
    var isVisible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    var isInViewport = rect.top < viewportH && rect.bottom > 0 && rect.left < viewportW && rect.right > 0;
    return {
      selector: selector,
      found: true,
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clientRect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      isVisible: isVisible,
      isInViewport: isInViewport,
      overflowX: overflowClass(style.overflowX, el.scrollWidth, el.clientWidth),
      overflowY: overflowClass(style.overflowY, el.scrollHeight, el.clientHeight),
      textOverflow: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
      actionSafe: isVisible && isInViewport,
      computed: {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
        opacity: style.opacity,
        zIndex: style.zIndex,
        transform: style.transform,
        display: style.display,
        position: style.position,
      },
    };
  });
})`;

export async function evaluateElementMetrics(page: Page, selectors: string[]): Promise<ElementMetrics[]> {
  return page.evaluate<ElementMetrics[], string[]>(ELEMENT_METRICS_SCRIPT, selectors);
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Default persistence root for still captures, mirroring `writeScreenshotArtifact()`'s layout. */
export function captureRoot(): string {
  const configured = process.env.FLUJO_BROWSER_SCREENSHOT_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dataRoot = process.env.FLUJO_DATA_DIR?.trim() || process.cwd();
  return path.resolve(dataRoot, 'screenshots', 'browser');
}

/** Write a capture artifact, confining any caller-supplied `outputPath` to the data dir or the capture root. */
export async function writeCaptureArtifact(
  outputPath: string | undefined,
  defaultRelativePath: string[],
  data: Buffer,
): Promise<string> {
  let filePath: string;
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    const dataDir = getDataDir();
    const root = captureRoot();
    if (!isInside(dataDir, resolved) && !isInside(root, resolved)) {
      throw new BrowserMcpError('INVALID_ARGUMENT', 'outputPath must be inside the FLUJO data directory or the browser screenshot root.');
    }
    filePath = resolved;
  } else {
    filePath = path.join(captureRoot(), ...defaultRelativePath);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  return filePath;
}
