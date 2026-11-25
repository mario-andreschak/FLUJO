import {
  DEFAULT_RUN_RESOURCE_SETTINGS,
  DEFAULT_TOOL_RESULT_MAX_LINES,
  type RunResourceSettings,
  type ToolResultLimitMode,
} from '@/shared/types/runResources';

/**
 * Tool result size limit (issue #1226): which results are moved to a run
 * resource, shared by every place FLUJO hands a tool result to a model (its
 * own tool loop, the Claude, Codex and Antigravity adapters, the native broker
 * and history reload) and by the Settings page that explains the numbers.
 *
 * Pure and browser-safe on purpose: no Buffer, no storage.
 */

/** FLUJO's request-size estimate counts four characters per token (wireTokenEstimate.ts). */
export const TOOL_RESULT_BYTES_PER_TOKEN = 4;
/**
 * Window assumed when a model does not state one: 128K tokens. Its safety
 * ceiling is exactly the old fixed default limit (256 KiB).
 */
export const TOOL_RESULT_FALLBACK_CONTEXT_TOKENS = 128 * 1024;
/** 'auto' gives one result an eighth of the window (Claude Code: 25,000 of 200,000 tokens). */
export const TOOL_RESULT_AUTO_WINDOW_DIVISOR = 8;
/** One result may never take more than half of the window, whatever the setting. */
export const TOOL_RESULT_SAFETY_WINDOW_DIVISOR = 2;
/** 'auto' never goes below this, so small models still see useful results. */
export const TOOL_RESULT_MIN_AUTO_BYTES = 16 * 1024;
/** The safety ceiling never goes below this, even for a tiny window. */
export const TOOL_RESULT_MIN_SAFETY_BYTES = 4 * 1024;
/** A custom limit is whole kilobytes (1 KB = 1024 bytes) in this range. */
export const TOOL_RESULT_CUSTOM_MIN_KB = 1;
export const TOOL_RESULT_CUSTOM_MAX_KB = 100 * 1024;
/** Largest accepted line limit; 0 means "no line limit". */
export const TOOL_RESULT_MAX_LINES_LIMIT = 10_000_000;

const KB = 1024;

export interface ToolResultBound {
  /** Results with more UTF-8 bytes than this are moved. Always > 0. */
  maxBytes: number;
  /** Results with more lines than this are moved; 0 = no line limit. */
  maxLines: number;
  /**
   * 'limit': the user's setting decided. 'safety': the setting is off, or a
   * custom limit is larger than the model can take, so the safety ceiling decided.
   */
  reason: 'limit' | 'safety';
  /** Half the model's context window, in bytes. */
  safetyBytes: number;
  /** Context window used for the numbers above, in tokens. */
  contextWindow: number;
  /** False when the model did not state a window and the 128K fallback was used. */
  contextWindowKnown: boolean;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** The model's window in tokens, or the 128K fallback when it is unknown. */
export function toolResultContextWindow(contextWindow?: number): { tokens: number; known: boolean } {
  const tokens = positiveInteger(contextWindow);
  return tokens ? { tokens, known: true } : { tokens: TOOL_RESULT_FALLBACK_CONTEXT_TOKENS, known: false };
}

/** Bytes of one result that would fill half of the model's context window. */
export function toolResultSafetyBytes(contextWindow?: number): number {
  const { tokens } = toolResultContextWindow(contextWindow);
  return Math.max(
    TOOL_RESULT_MIN_SAFETY_BYTES,
    Math.floor(tokens / TOOL_RESULT_SAFETY_WINDOW_DIVISOR) * TOOL_RESULT_BYTES_PER_TOKEN,
  );
}

/** The 'auto' limit: an eighth of the window, at least 16 KiB, never above the safety ceiling. */
export function autoToolResultBytes(contextWindow?: number): number {
  const { tokens } = toolResultContextWindow(contextWindow);
  const share = Math.floor(tokens / TOOL_RESULT_AUTO_WINDOW_DIVISOR) * TOOL_RESULT_BYTES_PER_TOKEN;
  return Math.min(toolResultSafetyBytes(contextWindow), Math.max(TOOL_RESULT_MIN_AUTO_BYTES, share));
}

/**
 * The mode in effect. A settings object written before #1226 has no mode;
 * there the byte limit, when present, was always authoritative.
 */
export function toolResultLimitMode(settings: Partial<RunResourceSettings> | undefined): ToolResultLimitMode {
  if (settings?.toolResultLimitMode === 'auto' || settings?.toolResultLimitMode === 'custom') {
    return settings.toolResultLimitMode;
  }
  return settings?.toolResultMaxBytes !== undefined ? 'custom' : 'auto';
}

/**
 * Decide which tool results are moved for a model with this context window.
 * Off still moves a result over half the window, so a run never fails just
 * because one tool answered with too much text.
 */
export function resolveToolResultBound(
  settings: Partial<RunResourceSettings> | undefined,
  contextWindow?: number,
): ToolResultBound {
  const window = toolResultContextWindow(contextWindow);
  const safetyBytes = toolResultSafetyBytes(contextWindow);
  const base = { safetyBytes, contextWindow: window.tokens, contextWindowKnown: window.known };
  if (settings?.toolResultTruncationEnabled !== true) {
    return { ...base, maxBytes: safetyBytes, maxLines: 0, reason: 'safety' };
  }
  const maxLines = nonNegativeInteger(settings.toolResultMaxLines) ?? DEFAULT_TOOL_RESULT_MAX_LINES;
  if (toolResultLimitMode(settings) === 'auto') {
    return { ...base, maxBytes: autoToolResultBytes(contextWindow), maxLines, reason: 'limit' };
  }
  // 0 (or nothing usable) switches the byte limit off; the safety ceiling stays.
  const configured = positiveInteger(settings.toolResultMaxBytes) ?? Number.POSITIVE_INFINITY;
  return configured > safetyBytes
    ? { ...base, maxBytes: safetyBytes, maxLines, reason: 'safety' }
    : { ...base, maxBytes: configured, maxLines, reason: 'limit' };
}

// --- Settings page and API ---------------------------------------------------

/** The four fields the Settings page edits. */
export interface ToolResultLimitSettings {
  toolResultTruncationEnabled: boolean;
  toolResultLimitMode: ToolResultLimitMode;
  toolResultMaxBytes: number;
  toolResultMaxLines: number;
}

export type ToolResultLimitPatch = Partial<ToolResultLimitSettings>;

export type ToolResultLimitError =
  | 'invalid-body'
  | 'unknown-field'
  | 'invalid-enabled'
  | 'invalid-mode'
  | 'invalid-size'
  | 'invalid-lines';

export type ToolResultLimitValidation =
  | { ok: true; patch: ToolResultLimitPatch }
  | { ok: false; error: ToolResultLimitError; field?: string };

const PATCH_FIELDS = new Set<string>([
  'toolResultTruncationEnabled',
  'toolResultLimitMode',
  'toolResultMaxBytes',
  'toolResultMaxLines',
]);

/** True for a whole number of bytes inside the custom range (1 KB to 100 MB). */
export function isValidCustomToolResultBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= TOOL_RESULT_CUSTOM_MIN_KB * KB && value <= TOOL_RESULT_CUSTOM_MAX_KB * KB;
}

export function isValidToolResultMaxLines(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= TOOL_RESULT_MAX_LINES_LIMIT;
}

/** Check a change sent by the Settings page. Unknown fields are refused, not ignored. */
export function validateToolResultLimitPatch(body: unknown): ToolResultLimitValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid-body' };
  const fields = body as Record<string, unknown>;
  const unknownField = Object.keys(fields).find((key) => !PATCH_FIELDS.has(key));
  if (unknownField) return { ok: false, error: 'unknown-field', field: unknownField };
  const patch: ToolResultLimitPatch = {};
  if (fields.toolResultTruncationEnabled !== undefined) {
    if (typeof fields.toolResultTruncationEnabled !== 'boolean') {
      return { ok: false, error: 'invalid-enabled', field: 'toolResultTruncationEnabled' };
    }
    patch.toolResultTruncationEnabled = fields.toolResultTruncationEnabled;
  }
  if (fields.toolResultLimitMode !== undefined) {
    if (fields.toolResultLimitMode !== 'auto' && fields.toolResultLimitMode !== 'custom') {
      return { ok: false, error: 'invalid-mode', field: 'toolResultLimitMode' };
    }
    patch.toolResultLimitMode = fields.toolResultLimitMode;
  }
  if (fields.toolResultMaxBytes !== undefined) {
    if (!isValidCustomToolResultBytes(fields.toolResultMaxBytes)) {
      return { ok: false, error: 'invalid-size', field: 'toolResultMaxBytes' };
    }
    patch.toolResultMaxBytes = fields.toolResultMaxBytes;
  }
  if (fields.toolResultMaxLines !== undefined) {
    if (!isValidToolResultMaxLines(fields.toolResultMaxLines)) {
      return { ok: false, error: 'invalid-lines', field: 'toolResultMaxLines' };
    }
    patch.toolResultMaxLines = fields.toolResultMaxLines;
  }
  return { ok: true, patch };
}

/**
 * Read a stored settings file safely: missing or broken values fall back to
 * the defaults instead of breaking tool calls, and a file written before
 * #1226 with a hand-set byte limit keeps that limit ('custom').
 */
export function normalizeRunResourceSettings(stored: unknown): RunResourceSettings {
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Partial<RunResourceSettings>
    : {};
  const merged: RunResourceSettings = { ...DEFAULT_RUN_RESOURCE_SETTINGS, ...raw };
  merged.toolResultTruncationEnabled = raw.toolResultTruncationEnabled === true;
  merged.toolResultLimitMode = toolResultLimitMode(raw);
  if (raw.toolResultMaxBytes !== undefined && nonNegativeInteger(raw.toolResultMaxBytes) === undefined) {
    merged.toolResultMaxBytes = DEFAULT_RUN_RESOURCE_SETTINGS.toolResultMaxBytes;
    if (raw.toolResultLimitMode === undefined) merged.toolResultLimitMode = 'auto';
  }
  if (raw.toolResultMaxLines !== undefined && nonNegativeInteger(raw.toolResultMaxLines) === undefined) {
    merged.toolResultMaxLines = DEFAULT_RUN_RESOURCE_SETTINGS.toolResultMaxLines;
  }
  return merged;
}

/** The Settings page's view of the stored settings. */
export function toolResultLimitSettings(settings: Partial<RunResourceSettings>): ToolResultLimitSettings {
  const normalized = normalizeRunResourceSettings(settings);
  return {
    toolResultTruncationEnabled: normalized.toolResultTruncationEnabled,
    toolResultLimitMode: toolResultLimitMode(normalized),
    toolResultMaxBytes: normalized.toolResultMaxBytes ?? DEFAULT_RUN_RESOURCE_SETTINGS.toolResultMaxBytes!,
    toolResultMaxLines: normalized.toolResultMaxLines ?? DEFAULT_TOOL_RESULT_MAX_LINES,
  };
}

/** Kilobytes typed by a person (whole numbers only) to bytes; null when not valid. */
export function kilobytesToToolResultBytes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const bytes = Number(trimmed) * KB;
  return isValidCustomToolResultBytes(bytes) ? bytes : null;
}

/** Bytes shown as whole kilobytes (rounded up, so a limit is never understated as 0 KB). */
export function toolResultBytesToKilobytes(bytes: number): number {
  return Math.max(0, Math.ceil(bytes / KB));
}
