/**
 * Deterministic still capture for the browser MCP server (#366).
 *
 * Kept out of `tools.ts`/`runtime.ts` to keep those under control, per the
 * plan. Everything here operates on a `Page` handed in by the caller — either
 * an ephemeral capture context (`createCaptureContext()` in `runtime.ts`) or
 * an existing session's page — and never owns session lifecycle itself.
 *
 * Sources intentionally use the same permissive target normalization as
 * ordinary browser navigation. Models may pass a URL, localhost address,
 * local path, file:// URL, or inline HTML without having to coordinate policy
 * flags. Output paths remain confined to FLUJO's data roots.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ElementHandle, Page } from 'patchright';
import { BrowserMcpError, assertNavigationAllowed } from './runtime.js';

export type Resolution = { width: number; height: number };

export type ResolutionOptions = {
  defaultValue: Resolution;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  even?: boolean;
};

export type NormalizedResolution = {
  requested: Resolution;
  effective: Resolution;
  explicit: boolean;
  warnings: string[];
};

const RESOLUTION_PRESETS: Record<string, Resolution> = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  hd: { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  fhd: { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  qhd: { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
  '4k': { width: 3840, height: 2160 },
};

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseResolution(value: unknown): Resolution | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
    if (RESOLUTION_PRESETS[normalized]) return { ...RESOLUTION_PRESETS[normalized] };
    const match = /^(\d{2,5})[x×](\d{2,5})$/.exec(normalized);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const width = finiteNumber(record.width);
    const height = finiteNumber(record.height);
    if (width !== undefined && height !== undefined) return { width, height };
  }
  return undefined;
}

function fitInside(value: Resolution, maxWidth: number, maxHeight: number): Resolution {
  const scale = Math.min(1, maxWidth / value.width, maxHeight / value.height);
  return {
    width: Math.round(value.width * scale),
    height: Math.round(value.height * scale),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function makeEven(value: number, min: number): number {
  const rounded = Math.max(min, value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/** Normalize presets, WIDTHxHEIGHT strings, objects, and legacy width/height values. */
export function normalizeResolution(
  resolution: unknown,
  legacyWidth: unknown,
  legacyHeight: unknown,
  options: ResolutionOptions,
): NormalizedResolution {
  const warnings: string[] = [];
  const parsed = parseResolution(resolution);
  const legacyW = finiteNumber(legacyWidth);
  const legacyH = finiteNumber(legacyHeight);
  const explicit = parsed !== undefined || legacyW !== undefined || legacyH !== undefined;
  let requested = parsed ?? {
    width: legacyW ?? options.defaultValue.width,
    height: legacyH ?? options.defaultValue.height,
  };

  if (resolution !== undefined && !parsed) {
    warnings.push(`Unrecognized resolution ${JSON.stringify(resolution)}; using ${requested.width}x${requested.height}.`);
  }
  if (!parsed && (legacyW !== undefined || legacyH !== undefined)) {
    requested = {
      width: legacyW ?? Math.round((requested.height * options.defaultValue.width) / options.defaultValue.height),
      height: legacyH ?? Math.round((requested.width * options.defaultValue.height) / options.defaultValue.width),
    };
  }

  const fitted = fitInside({
    width: Math.max(1, requested.width),
    height: Math.max(1, requested.height),
  }, options.maxWidth, options.maxHeight);
  let effective = {
    width: clamp(fitted.width, options.minWidth, options.maxWidth),
    height: clamp(fitted.height, options.minHeight, options.maxHeight),
  };
  if (options.even) {
    effective = {
      width: makeEven(effective.width, options.minWidth),
      height: makeEven(effective.height, options.minHeight),
    };
  }
  requested = { width: Math.round(requested.width), height: Math.round(requested.height) };

  if (effective.width !== requested.width || effective.height !== requested.height) {
    warnings.push(
      `Requested ${requested.width}x${requested.height}; using the supported ${effective.width}x${effective.height} resolution.`,
    );
  }
  return { requested, effective, explicit, warnings };
}

/** Try the requested size first, then progressively safer standard resolutions. */
export function resolutionFallbacks(primary: Resolution): Resolution[] {
  const candidates: Resolution[] = [
    primary,
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 854, height: 480 },
    { width: 640, height: 360 },
  ];
  const seen = new Set<string>();
  return candidates.filter(({ width, height }) => {
    const key = `${width}x${height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function finiteParameter(value: unknown, fallback: number): number {
  return finiteNumber(value) ?? fallback;
}

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
  | { kind: 'html'; html: string; warnings: string[] }
  | { kind: 'url'; url: string; warnings: string[] };

/** Assert a single, stable PNG color type and return it. Never silently accepts a malformed image. */
export function pngColorType(png: Buffer): number {
  if (png.length <= PNG_COLOR_TYPE_OFFSET || png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new BrowserMcpError('UNEXPECTED', 'The captured image is not a valid PNG.');
  }
  return png.readUInt8(PNG_COLOR_TYPE_OFFSET);
}

/**
 * Resolve the compact `source` parameter while retaining the old url/html/
 * filePath aliases. If a caller supplies several aliases, choose the clearest
 * one and report the adjustment instead of failing the whole tool call.
 */
export async function resolveCaptureSource(args: {
  source?: unknown;
  url?: string;
  html?: string;
  filePath?: string;
  allowLocal?: boolean;
}): Promise<CaptureSource> {
  const warnings: string[] = [];
  const compact = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : undefined;
  const html = typeof args.html === 'string' && args.html.length > 0 ? args.html : undefined;
  const filePath = typeof args.filePath === 'string' && args.filePath.trim() ? args.filePath.trim() : undefined;
  const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
  const count = [compact, html, filePath, url].filter(Boolean).length;
  if (count === 0) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Provide source, or omit it while supplying an active sessionId.');
  }
  if (count > 1) warnings.push('Several capture sources were supplied; source/html/filePath/url precedence was applied.');

  const chosen = compact ?? html ?? filePath ?? url!;
  const isHtml = compact
    ? /^\s*(?:<!doctype\s+html|<html|<body|<svg|<[A-Za-z][^>]*>)/i.test(compact)
    : html !== undefined && chosen === html;
  if (isHtml) return { kind: 'html', html: chosen, warnings };
  const target = await assertNavigationAllowed(chosen);
  return { kind: 'url', url: target.href, warnings };
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
  source: CaptureSource | undefined,
  options: CapturePageOptions,
): Promise<{ png: Buffer; colorType: number }> {
  const timeout = options.timeoutMs;
  if (source?.kind === 'html') {
    await page.setContent(source.html, { waitUntil: 'load', timeout });
  } else if (source) {
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
  source: CaptureSource | undefined,
  region: CaptureRegion,
  timeoutMs: number,
): Promise<{ png: Buffer; colorType: number }> {
  if (source?.kind === 'html') {
    await page.setContent(source.html, { waitUntil: 'load', timeout: timeoutMs });
  } else if (source) {
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
