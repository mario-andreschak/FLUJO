/**
 * Built-in `filesystem` MCP server (issue #170).
 *
 * Cross-platform (Windows/macOS/Linux) filesystem access with:
 *  - structured JSON outputs (MCP `structuredContent` + a text fallback block),
 *  - line-targeted reads AND writes/edits,
 *  - literal find/replace edits AND real unified-diff (`@@`) patch apply,
 *  - directory listing/tree and name/content search.
 *
 * Relative paths resolve against the FLUJO data directory; absolute paths are
 * honored as-is (same host-access posture as the legacy `terminal` tool). Two
 * layers of confinement can narrow that:
 *  - the FLUJO_FS_ROOTS env (path-list separated by the OS path delimiter) acts
 *    as a HARD CEILING an operator sets — no path may ever escape it, and
 *  - user-configured roots persisted via the MCP manager UI (issue #170), which
 *    may only narrow WITHIN the env ceiling (never widen it).
 * When neither is set the server has full host access.
 *
 * Every tool returns a machine-readable JSON envelope both as MCP
 * `structuredContent` and as a single text content block (for backward-compat
 * clients); errors are returned as `isError: true` results rather than thrown.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import type { Tool, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  createLogger,
  getDataDir,
  isInside,
  loadEffectiveRoots,
} from '@flujo-ai/mcp-shared';
import { recordTouchedFile } from './resources.js';
import { detectMediaFile, mimeTypeFromExtension, mediaTypeFromMime, looksBinaryHeuristic } from './media.js';

const FILESYSTEM_SERVER_NAME = 'filesystem';

const log = createLogger('backend/services/mcp/internal/filesystemTools');

/** Output cap so a huge file/listing can't flood the model's context. */
const MAX_READ_CHARS = 200_000;
/** #316: bound batch fan-out and its cumulative serialized response size. */
const MAX_BATCH_READ_FILES = 25;
const MAX_BATCH_READ_CHARS = 1_000_000;
const MAX_SEARCH_RESULTS = 1_000;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 10;
const MAX_TREE_ENTRIES = 5_000;

// Advertise the real side-effect profile to MCP clients. Codex in particular
// uses these hints to distinguish safe discovery/reads from mutations instead
// of treating every FLUJO filesystem operation as an unknown-risk action.
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/**
 * #287: files at/above this size may not be read whole without an explicit
 * `pattern` (grep first, then targeted line reads) — or a `*` opt-in. Keeps a
 * large file from silently flooding the model's context on a bare read.
 */
const LARGE_FILE_BYTES = 100_000;
/**
 * #365: media never enters the context as text — it is captured to a run
 * resource and re-attached as a native media input — so LARGE_FILE_BYTES (a
 * context-flood guard for TEXT) must not apply to it. What DOES need a cap is
 * memory: the file is buffered whole and base64 costs another ~1.33x. This
 * bound sits under the 50 MB per-run-resource cap so an accepted read can
 * always be stored.
 */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
/** #287: skip files bigger than this during content search (perf/binary guard). */
const SEARCH_MAX_FILE_BYTES = 5_000_000;
/** #287: how many files to scan concurrently during a content search. */
const SEARCH_CONCURRENCY = 16;
/** #287: context lines shown around each `read_file` pattern match. */
const READ_PATTERN_CONTEXT = 2;
/** #287: cap on matches returned by a single `read_file` pattern grep. */
const MAX_READ_PATTERN_MATCHES = 200;
/** #487: bound caller-controlled regular expressions before compiling them. */
const MAX_READ_PATTERN_LENGTH = 4_096;

type SearchMatch = { path: string; line?: number; text?: string };

/**
 * ripgrep is an installer-provided acceleration, not a runtime requirement.
 * Cache by PATH value so a process whose environment is refreshed after an
 * install can discover it without restarting. `undefined` means automatic,
 * while `null` is a test-only forced fallback.
 */
let ripgrepCache: { pathValue: string; executable: string | null } | undefined;
let ripgrepExecutableForTests: string | null | undefined;
const activeRipgrepChildren = new Set<ReturnType<typeof spawn>>();

/** Test seam: force a ripgrep executable, force the Node fallback with null, or reset with undefined. */
export function _setRipgrepExecutableForTests(value: string | null | undefined): void {
  ripgrepExecutableForTests = value;
  ripgrepCache = undefined;
}

/** Kill external search accelerators before the filesystem MCP process exits. */
export function shutdownFilesystemSearches(): void {
  for (const child of activeRipgrepChildren) {
    try { child.kill(); } catch { /* best-effort shutdown */ }
  }
  activeRipgrepChildren.clear();
}

/** SDK 1.29's exported CallToolResult predates `structuredContent`; widen locally. */
type StructuredResult = CallToolResult & { structuredContent?: Record<string, unknown> };

/** Return a structured payload as BOTH MCP structuredContent and a text fallback. */
function dualResult(payload: Record<string, unknown>): StructuredResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Return a plain string/error message (no structuredContent). */
function textResult(message: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Return an error envelope (JSON text + isError). */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * Translate the slash-drive form some models emit into a native Windows path.
 * Keep the platform injectable so the narrow conversion can be verified on any
 * host; all canonicalization and confinement still happen in resolvePath().
 */
export function _normalizeSlashDrivePathForTests(
  raw: string,
  platform: NodeJS.Platform = process.platform
): string {
  const match = /^\/([A-Za-z])(?:\/|$)/.exec(raw);
  if (platform !== 'win32' || !match) return raw;

  const driveRoot = `${match[1].toUpperCase()}:\\`;
  const remainder = raw.slice(match[0].length).split('/').join(path.win32.sep);
  return remainder ? `${driveRoot}${remainder}` : driveRoot;
}

/**
 * Resolve a user-supplied path against the data dir (for relative paths) and
 * enforce the effective confinement roots. An empty roots array blocks all access.
 * Throws on a confinement violation so callers surface a precise error.
 */
async function resolvePath(input: unknown, roots: string[]): Promise<string> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('Provide "path".');
  const normalized = _normalizeSlashDrivePathForTests(raw);
  const dataDir = getDataDir();
  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(dataDir, normalized);

  if (roots.length === 0 || !roots.some((root) => isInside(root, resolved))) {
    throw new Error(`Path "${resolved}" is outside the configured filesystem roots.`);
  }
  return resolved;
}

export function filesystemToolDefinitions(): Tool[] {
  const pathProp = { type: 'string', description: 'File or directory path. Relative paths start at the FLUJO data directory.' };
  return [
    {
      name: 'read_file',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        `Read text or media files. Use "path" for one file or "paths" for up to 25; do not use both. For text, "from"/"to" select lines and "pattern" is a case-insensitive regular expression. Regex metacharacters have their usual meaning and must be escaped for literal matching; invalid expressions or expressions over ${MAX_READ_PATTERN_LENGTH} characters return an error. Files over ${LARGE_FILE_BYTES / 1000} KB need a line range or pattern; the exact pattern "*" is a reserved sentinel that reads the whole file. Media limit: ${MAX_MEDIA_BYTES / (1024 * 1024)} MB. Use the returned contentHash as expectedHash when editing.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          paths: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH_READ_FILES,
            items: { type: 'string' },
            description: 'File paths to read in input order. Mutually exclusive with "path".',
          },
          from: { type: 'number', description: 'Optional 1-based first line to return (inclusive).' },
          to: { type: 'number', description: 'Optional 1-based last line to return (inclusive).' },
          pattern: { type: 'string', description: `Case-insensitive regular expression, limited to ${MAX_READ_PATTERN_LENGTH} characters. Regex metacharacters have their usual meaning; escape them for a literal match. Invalid or over-limit expressions return a tool error. Required to read a large file whole without a "from"/"to" range; matching lines plus context are returned instead of the full body. The exact value "*" is reserved to read the whole file.` },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          files: {
            type: 'array',
            description: 'Ordered batch results. Successful entries use the single-file payload; failures include requestedPath and error.',
            items: { type: 'object' },
          },
          from: { type: 'number' },
          to: { type: 'number' },
          totalLines: { type: 'number' },
          truncated: { type: 'boolean' },
          content: { type: 'string' },
          contentHash: { type: 'string', description: 'SHA-256 (hex) of the raw file content. Pass this back as "expectedHash" to edit_file/write_file to guard against the file changing between read and write (TOCTOU).' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: { line: { type: 'number' }, text: { type: 'string' } },
              required: ['line', 'text'],
            },
          },
        },
      },
    },
    {
      name: 'write_file',
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
      description:
        'Write a text file and create missing parent directories. Modes: overwrite (default), append, or insert before startLine. For a range overwrite, give startLine and endLine. Use expectedHash from read_file to reject changes to a stale file; it is ignored for whole-file overwrite.',
      // #216: feed the docked diff canvas (ui://devcanvas/diff) so successive
      // writes update one persistent tab. See internal/filesystemResources.ts.
      _meta: { ui: { resourceUri: 'ui://devcanvas/diff' } },
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          content: { type: 'string', description: 'The content to write/insert/append.' },
          mode: { type: 'string', enum: ['overwrite', 'append', 'insert'], description: 'Write mode (default "overwrite").' },
          startLine: { type: 'number', description: 'For "insert": line to insert before. For "overwrite": first line of the range to replace (1-based).' },
          endLine: { type: 'number', description: 'For "overwrite": last line (inclusive, 1-based) of the range to replace.' },
          expectedHash: { type: 'string', description: 'Optional SHA-256 (contentHash from read_file). For append/insert/range-overwrite modes, the write is rejected if the file no longer hashes to this value (TOCTOU guard).' },
        },
        required: ['path', 'content'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytesWritten: { type: 'number' },
          mode: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
          linesReplaced: { type: 'number' },
          linesInserted: { type: 'number' },
        },
        required: ['path', 'bytesWritten', 'mode'],
      },
    },
    {
      name: 'edit_file',
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
      description:
        'Edit a text file with either "edits" or "diff"; do not use both. Each oldText must match once, so include enough context to make it unique. A unified diff is applied atomically. Use expectedHash from read_file to reject edits to a stale file.',
      // #216: also feed the docked diff canvas so edits show live in the canvas.
      _meta: { ui: { resourceUri: 'ui://devcanvas/diff' } },
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          edits: {
            type: 'array',
            description: 'List of literal { oldText, newText } edits applied in order (optionally scoped with startLine/endLine).',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text to find.' },
                newText: { type: 'string', description: 'Replacement text.' },
                startLine: { type: 'number', description: 'Optional 1-based first line to scope this edit to.' },
                endLine: { type: 'number', description: 'Optional 1-based last line (inclusive) to scope this edit to.' },
              },
              required: ['oldText', 'newText'],
            },
          },
          diff: { type: 'string', description: 'A unified diff to apply atomically. Mutually exclusive with "edits".' },
          startLine: { type: 'number', description: 'Optional default 1-based first line to scope all literal edits to.' },
          endLine: { type: 'number', description: 'Optional default 1-based last line (inclusive) to scope all literal edits to.' },
          expectedHash: { type: 'string', description: 'Optional SHA-256 (contentHash from read_file). If provided and the freshly-read file no longer hashes to it, the edit is rejected with no changes written (TOCTOU guard).' },
        },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          mode: { type: 'string' },
          editsApplied: { type: 'number' },
          applied: { type: 'boolean' },
          diff: {
            type: 'object',
            properties: { added: { type: 'number' }, removed: { type: 'number' } },
            required: ['added', 'removed'],
          },
        },
        required: ['path', 'diff'],
      },
    },
    {
      name: 'list_dir',
      annotations: READ_ONLY_ANNOTATIONS,
      description: 'List a directory. Each entry includes name, type, and size.',
      inputSchema: {
        type: 'object',
        properties: { path: pathProp },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, type: { type: 'string' }, size: { type: 'number' } },
              required: ['name', 'type', 'size'],
            },
          },
        },
        required: ['path', 'entries'],
      },
    },
    {
      name: 'file_browser_ui',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        'Ask the user to pick a file in an interactive browser. This returns before they choose. After calling it, STOP and wait for a follow-up user message containing the selected path.',
      // MCP Apps (#97): this tool exists solely to surface the file-browser app
      // (ui://filesystem/browser). See internal/filesystemResources.ts.
      _meta: { ui: { resourceUri: 'ui://filesystem/browser' } },
      inputSchema: {
        type: 'object',
        properties: {
          path: { ...pathProp, description: 'Optional starting directory for the browser (defaults to the FLUJO data directory).' },
        },
        required: [],
      },
    },
    {
      name: 'dir_tree',
      annotations: READ_ONLY_ANNOTATIONS,
      description: 'List a directory tree recursively, limited by depth.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          depth: { type: 'number', description: `Maximum recursion depth (default ${DEFAULT_TREE_DEPTH}, max ${MAX_TREE_DEPTH}).` },
        },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          depth: { type: 'number' },
          truncated: { type: 'boolean' },
          tree: { type: 'array' },
        },
        required: ['path', 'depth', 'tree'],
      },
    },
    {
      name: 'search',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        'Search a directory tree by namePattern and/or text content. Matching is case-insensitive. Content matches include line numbers. Binary and very large files are skipped.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          namePattern: { type: 'string', description: 'Optional case-insensitive substring to match against entry names.' },
          content: { type: 'string', description: 'Optional case-insensitive substring to match inside text files.' },
        },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, line: { type: 'number' }, text: { type: 'string' } },
              required: ['path'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['matches', 'truncated'],
      },
    },
    {
      name: 'get_file_info',
      annotations: READ_ONLY_ANNOTATIONS,
      description: 'Get a path\'s type, size, and creation and modification times.',
      inputSchema: {
        type: 'object',
        properties: { path: pathProp },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          type: { type: 'string' },
          size: { type: 'number' },
          isFile: { type: 'boolean' },
          isDirectory: { type: 'boolean' },
          createdAt: { type: 'string' },
          modifiedAt: { type: 'string' },
        },
        required: ['path', 'type', 'size', 'isFile', 'isDirectory', 'createdAt', 'modifiedAt'],
      },
    },
    {
      name: 'create_directory',
      annotations: WRITE_ANNOTATIONS,
      description: 'Create a directory and any missing parents. Succeeds if it exists.',
      inputSchema: {
        type: 'object',
        properties: { path: pathProp },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, created: { type: 'boolean' } },
        required: ['path', 'created'],
      },
    },
    {
      name: 'move',
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
      description: 'Move or rename a file or directory.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Existing path to move.' },
          destination: { type: 'string', description: 'Target path.' },
        },
        required: ['source', 'destination'],
      },
      outputSchema: {
        type: 'object',
        properties: { source: { type: 'string' }, destination: { type: 'string' } },
        required: ['source', 'destination'],
      },
    },
    {
      name: 'delete',
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
      description: 'Delete a file or directory. Set recursive to true for a non-empty directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          recursive: { type: 'boolean', description: 'Remove directories and their contents recursively.' },
        },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, deleted: { type: 'boolean' } },
        required: ['path', 'deleted'],
      },
    },
    {
      name: 'get_allowed_directories',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        'List the directories this server is allowed to access.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: {
          directories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths of all allowed directories.',
          },
        },
        required: ['directories'],
      },
    },
  ];
}

function splitLines(content: string): string[] {
  // Keep it simple + cross-platform: normalize CRLF/CR to LF for counting.
  return content.replace(/\r\n?/g, '\n').split('\n');
}

/** Detect the dominant line ending of an existing file so writes stay consistent. */
function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** UTF-8 byte-order-mark character (U+FEFF) as it decodes into a JS string. */
const UTF8_BOM = '﻿';

/**
 * #254 (TOCTOU guard): SHA-256 (hex) of the RAW string as read from disk
 * (before any CRLF/BOM normalization). `read_file` returns this as `contentHash`;
 * the mutating tools accept it back as an optional `expectedHash` and refuse to
 * write when the freshly-read file no longer hashes to it — catching the case
 * where the file changed on disk during the (arbitrarily long) approval window.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Split a leading UTF-8 BOM off `content` so it can be re-attached after edit. */
function splitBom(content: string): { bom: string; body: string } {
  return content.startsWith(UTF8_BOM)
    ? { bom: UTF8_BOM, body: content.slice(UTF8_BOM.length) }
    : { bom: '', body: content };
}

/** Standard actionable message when the on-disk file changed after approval. */
const STALE_CONTENT_MESSAGE =
  'File changed after permission approval. Read it again before editing. No changes written.';

/** Legacy heuristic binary sniff: a NUL byte in the first chunk means "not text". */
function looksBinary(buf: Buffer): boolean {
  return looksBinaryHeuristic(buf);
}

/**
 * Build a media content result (image/audio/video) as a CallToolResult.
 * The capture infrastructure will auto-capture the base64 data to run resources.
 */
function mediaResult(
  filePath: string,
  buf: Buffer,
  mediaType: 'image' | 'audio' | 'video',
  mimeType: string,
): StructuredResult {
  const base64Data = buf.toString('base64');
  // Build the structured content for return (not the media item itself)
  const payload = {
    path: filePath,
    mediaType,
    mimeType,
    size: buf.length,
    encoding: 'base64',
  };

  // Return a CallToolResult with the media content item.
  // The capture infrastructure will intercept this and replace it with a run-resource URI.
  // SDK CallToolResult only supports 'image' and 'audio' types in the SDK definition.
  // For 'video', we build the item generically and cast it.
  const item: Record<string, unknown> = {
    type: mediaType,
    data: base64Data,
    mimeType,
  };
  const result: StructuredResult = {
    content: [
      item as CallToolResult['content'][number],
      // Text fallback alongside the media item: every other read_file path
      // returns one (dualResult), MCP clients without media support would
      // otherwise see an empty result, and the capture layer replaces the media
      // item with a stub — leaving no trace of WHAT was read without this.
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      } as CallToolResult['content'][number],
    ],
    structuredContent: payload,
  };
  return result;
}

function compileReadPattern(pattern: string): RegExp | undefined {
  if (!pattern || pattern === '*') return undefined;
  if (pattern.length > MAX_READ_PATTERN_LENGTH) {
    throw new Error(
      `Invalid regular expression: pattern exceeds the ${MAX_READ_PATTERN_LENGTH}-character limit.`
    );
  }
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    const detail = err instanceof Error
      ? err.message.replace(/^Invalid regular expression:\s*/i, '')
      : 'the pattern could not be compiled.';
    throw new Error(`Invalid regular expression: ${detail}`);
  }
}

async function readSingleFileTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const filePath = await resolvePath(args.path, roots);

  const hasRange = typeof args.from === 'number' || typeof args.to === 'number';
  const suppliedPattern = typeof args.pattern === 'string' ? args.pattern : '';
  const pattern = suppliedPattern.trim() ? suppliedPattern : '';
  const patternRegex = compileReadPattern(pattern);

  // #287: guard whole-file reads of large files. Stat first so we never buffer a
  // huge file just to reject it. An explicit line range or a `pattern` opts out.
  let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    stat = await fs.stat(filePath);
  } catch {
    // fall through: fs.readFile below surfaces the real ENOENT/EACCES error.
  }
  if (stat && !stat.isFile()) {
    throw new Error('Expected a regular file to read.');
  }
  const size = Number(stat?.size ?? 0);

  // #365: decide whether this is media BEFORE the text-oriented size gate.
  // Start with the cheap extension signal, then probe a bounded header when the
  // extension is missing or misleading. The probe is essential for large media
  // with extensionless paths: without it `pattern: "*"` could still bypass the
  // media cap and make readFile buffer an arbitrarily large payload.
  const likelyMediaMime = mimeTypeFromExtension(filePath);
  let likelyMedia = likelyMediaMime !== null && mediaTypeFromMime(likelyMediaMime) !== 'file';
  if (!likelyMedia && size > LARGE_FILE_BYTES) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(filePath, 'r');
      const header = Buffer.alloc(Math.min(size, 512));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      likelyMedia = detectMediaFile(header.subarray(0, bytesRead), filePath) !== null;
    } finally {
      await handle?.close();
    }
  }

  if (likelyMedia && size > MAX_MEDIA_BYTES) {
    return errorResult(
      `Media file is too large to load (${size} bytes > ${MAX_MEDIA_BYTES} limit). ` +
      `Reading it would buffer the whole file in memory and exceed the run-resource size cap. ` +
      `Use the file path directly with a tool that streams it instead.`
    );
  }

  if (!likelyMedia && size > LARGE_FILE_BYTES && !hasRange && !pattern) {
    return errorResult(
      `File is large (${size} bytes > ${LARGE_FILE_BYTES} threshold). Reading it whole would flood the context. ` +
      `Provide a "pattern" to grep for (matching lines + context are returned, then read targeted ranges with "from"/"to"), ` +
      `or pass pattern "*" to read the whole file anyway.`
    );
  }

  // #365: Read as buffer first to detect media files BEFORE any text processing.
  // This ensures pattern/range on media files are rejected appropriately.
  const buf = await fs.readFile(filePath);
  recordTouchedFile(filePath, 'read', size);

  // #365: Check if this is a media file (image/audio/video).
  const mediaDetection = detectMediaFile(buf, filePath);
  if (mediaDetection) {
    // Media files cannot be pattern-grepped or range-read as text. A bare read
    // is always allowed now (see the size-gate note above), so this no longer
    // contradicts any other guard — it just rejects a nonsensical request.
    if (hasRange || (pattern && pattern !== '*')) {
      return errorResult(
        `File is ${mediaDetection.mimeType} media, not text. ` +
        `Pattern grep and line-range reads do not apply to it. ` +
        `Read it with "path" alone to get the media content.`
      );
    }
    // Media files are returned as-is (no line ranges or pattern grepping for media).
    return mediaResult(filePath, buf, mediaDetection.mediaType, mediaDetection.mimeType);
  }

  // #287: pattern grep path (only when no explicit range was given). `*` is the
  // escape hatch that means "read the whole file regardless".
  if (pattern && pattern !== '*' && !hasRange) {
    if (looksBinary(buf)) {
      return errorResult(`File appears to be binary; cannot grep for a pattern: ${filePath}`);
    }
    const content = buf.toString('utf8');
    const lines = splitLines(content);
    const totalLines = lines.length;
    const matches: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      // The current expression has no stateful flags, but resetting lastIndex
      // keeps this safe if flags change later.
      patternRegex!.lastIndex = 0;
      if (patternRegex!.test(lines[i])) {
        matches.push({ line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= MAX_READ_PATTERN_MATCHES) break;
      }
    }
    const truncated = matches.length >= MAX_READ_PATTERN_MATCHES;
    // Build a readable excerpt: matching lines with a small context window,
    // line-numbered, with `…` separators between non-adjacent regions.
    const show = new Set<number>();
    for (const m of matches) {
      for (let l = m.line - READ_PATTERN_CONTEXT; l <= m.line + READ_PATTERN_CONTEXT; l++) {
        if (l >= 1 && l <= totalLines) show.add(l);
      }
    }
    const ordered = [...show].sort((a, b) => a - b);
    const parts: string[] = [];
    let prev = 0;
    for (const l of ordered) {
      if (prev && l > prev + 1) parts.push('…');
      parts.push(`${l}: ${lines[l - 1]}`);
      prev = l;
    }
    let out = parts.join('\n');
    if (out.length > MAX_READ_CHARS) out = out.slice(0, MAX_READ_CHARS) + '\n…[truncated]';
    return dualResult({
      path: filePath,
      from: 1,
      to: totalLines,
      totalLines,
      truncated,
      content: matches.length ? out : `(no lines matched pattern ${JSON.stringify(pattern)})`,
      matches,
      contentHash: contentHash(content),
    });
  }

  // Whole-file / explicit-range read (pattern '*' lands here too).
  // Not media: treat as text.
  let content: string;
  try {
    content = buf.toString('utf8');
  } catch {
    // Fallback: if UTF-8 decode fails, treat as binary and reject.
    return errorResult(
      `File at "${filePath}" is binary or not valid UTF-8. ` +
      `Try reading it as a media file if it's an image, audio, or video.`
    );
  }

  const lines = splitLines(content);
  const totalLines = lines.length;

  let from = typeof args.from === 'number' ? Math.max(1, Math.floor(args.from)) : 1;
  let to = typeof args.to === 'number' ? Math.floor(args.to) : totalLines;
  if (to < from) [from, to] = [to, from];
  to = Math.min(to, totalLines);

  let out = hasRange ? lines.slice(from - 1, to).join('\n') : content;
  let truncated = false;
  if (out.length > MAX_READ_CHARS) {
    out = out.slice(0, MAX_READ_CHARS) + '\n…[truncated]';
    truncated = true;
  }
  return dualResult({ path: filePath, from: hasRange ? from : 1, to: hasRange ? to : totalLines, totalLines, truncated, content: out, contentHash: contentHash(content) });
}

function resultPayload(result: CallToolResult): Record<string, unknown> {
  const structured = (result as StructuredResult).structuredContent;
  if (structured) return structured;
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') return { error: 'File read failed.' };
  try {
    const parsed: unknown = JSON.parse(text.text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { error: text.text };
  } catch {
    return { error: text.text };
  }
}

async function readFileTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const hasPath = Object.prototype.hasOwnProperty.call(args, 'path');
  const hasPaths = Object.prototype.hasOwnProperty.call(args, 'paths');
  if (hasPath && hasPaths) throw new Error('Provide either "path" or "paths", not both.');
  if (!hasPaths) return await readSingleFileTool(args, roots);

  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    throw new Error('Provide a non-empty "paths" array.');
  }
  if (args.paths.length > MAX_BATCH_READ_FILES) {
    throw new Error(`Provide at most ${MAX_BATCH_READ_FILES} paths.`);
  }
  if (args.paths.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('Every entry in "paths" must be a non-empty string.');
  }

  const files: Array<Record<string, unknown>> = [];
  // #365: a batch read used to keep only each result's structuredContent, so an
  // image requested via "paths" had its bytes silently discarded while the
  // single-"path" route returned them. Carry the media items through instead —
  // the per-file record still describes them, and downstream capture turns them
  // into run resources plus real model input.
  const batchMedia: CallToolResult['content'] = [];
  for (const requestedPath of args.paths as string[]) {
    let resolvedPath: string | undefined;
    let record: Record<string, unknown>;
    try {
      resolvedPath = await resolvePath(requestedPath, roots);
      const result = await readSingleFileTool({ ...args, path: requestedPath, paths: undefined }, roots);
      const payload = resultPayload(result);
      record = result.isError
        ? { requestedPath, path: resolvedPath, error: String(payload.error ?? 'File read failed.') }
        : payload;
      if (!result.isError) {
        for (const contentItem of result.content) {
          if (contentItem.type !== 'text') batchMedia.push(contentItem);
        }
      }
    } catch (err) {
      record = {
        requestedPath,
        ...(resolvedPath ? { path: resolvedPath } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const candidate = { files: [...files, record] };
    if (JSON.stringify(candidate).length > MAX_BATCH_READ_CHARS) {
      record = {
        requestedPath,
        ...(resolvedPath ? { path: resolvedPath } : {}),
        error: `Batch response limit of ${MAX_BATCH_READ_CHARS} serialized characters exceeded.`,
      };
    }
    files.push(record);
  }
  const batch = dualResult({ files });
  return batchMedia.length > 0
    ? { ...batch, content: [...batchMedia, ...batch.content] }
    : batch;
}

async function writeFileTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const filePath = await resolvePath(args.path, roots);
  const content = typeof args.content === 'string' ? args.content : '';
  const mode = args.mode === 'append' || args.mode === 'insert' ? args.mode : 'overwrite';
  const hasRange = typeof args.startLine === 'number' || typeof args.endLine === 'number';

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  recordTouchedFile(filePath, 'write');

  // Whole-file overwrite (default, backward-compatible).
  if (mode === 'overwrite' && !hasRange) {
    await fs.writeFile(filePath, content, 'utf8');
    return dualResult({ path: filePath, bytesWritten: Buffer.byteLength(content, 'utf8'), mode: 'overwrite' });
  }

  // The remaining modes operate relative to the existing file (empty if absent).
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    existing = '';
  }

  // #254 TOCTOU guard: for the read-modify-write modes (append/insert/range-
  // overwrite) honor an optional expectedHash (the contentHash from read_file)
  // and refuse to write when the file changed on disk since it was read.
  const expectedHash = typeof args.expectedHash === 'string' ? args.expectedHash : undefined;
  if (expectedHash && contentHash(existing) !== expectedHash) {
    return errorResult(STALE_CONTENT_MESSAGE);
  }

  // #254 BOM preservation: operate on the body and re-attach a leading UTF-8 BOM
  // (if the file had one) on write so the read-modify-write modes never drop it.
  const { bom, body: existingBody } = splitBom(existing);

  if (mode === 'append') {
    const sep = existingBody.length && !existingBody.endsWith('\n') && !existingBody.endsWith('\r\n') ? detectEol(existingBody) : '';
    const next = bom + existingBody + sep + content;
    await fs.writeFile(filePath, next, 'utf8');
    return dualResult({ path: filePath, bytesWritten: Buffer.byteLength(next, 'utf8'), mode: 'append' });
  }

  const eol = detectEol(existingBody);
  const lines = existingBody.length ? existingBody.split(/\r?\n/) : [];
  const insertLines = content.split(/\r?\n/);
  const total = lines.length;

  if (mode === 'insert') {
    const at = typeof args.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : total + 1;
    const idx = Math.min(at - 1, total);
    lines.splice(idx, 0, ...insertLines);
    const next = bom + lines.join(eol);
    await fs.writeFile(filePath, next, 'utf8');
    return dualResult({ path: filePath, bytesWritten: Buffer.byteLength(next, 'utf8'), mode: 'insert', startLine: at, linesInserted: insertLines.length });
  }

  // overwrite a specific line range
  let start = typeof args.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : 1;
  let end = typeof args.endLine === 'number' ? Math.floor(args.endLine) : start;
  if (end < start) [start, end] = [end, start];
  end = Math.min(end, total);
  const linesReplaced = Math.max(0, end - start + 1);
  lines.splice(start - 1, linesReplaced, ...insertLines);
  const next = bom + lines.join(eol);
  await fs.writeFile(filePath, next, 'utf8');
  return dualResult({ path: filePath, bytesWritten: Buffer.byteLength(next, 'utf8'), mode: 'overwrite', startLine: start, endLine: end, linesReplaced });
}

/**
 * Char offsets [lo, hi) of the 1-based inclusive line range [start, end] within
 * `text`. When both bounds are absent the whole string is returned. Offsets are
 * computed by counting `\n`. PRECONDITION: `text` must be LF-normalized (the
 * caller in `editFileTool` normalizes CR/CRLF to LF before matching), so every
 * newline is exactly one character and the `+ 1` advance stays byte-exact.
 */
function regionOffsets(text: string, start?: number, end?: number): { lo: number; hi: number } {
  if (start === undefined && end === undefined) return { lo: 0, hi: text.length };
  const lines = text.split('\n');
  const s = Math.max(1, Math.floor(start ?? 1));
  const e = Math.min(lines.length, Math.floor(end ?? lines.length));
  let lo = 0;
  for (let k = 0; k < s - 1 && k < lines.length; k++) lo += lines[k].length + 1;
  let hi = lo;
  for (let k = s - 1; k < e && k < lines.length; k++) hi += lines[k].length + (k < lines.length - 1 ? 1 : 0);
  return { lo, hi: Math.max(lo, hi) };
}

async function editFileTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const filePath = await resolvePath(args.path, roots);
  const hasDiff = typeof args.diff === 'string' && args.diff.trim().length > 0;
  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;

  if (hasDiff && hasEdits) {
    return errorResult('Provide either "diff" or "edits", not both.');
  }

  const original = await fs.readFile(filePath, 'utf8');

  // #254 TOCTOU guard: if the caller passed the contentHash it saw at read time
  // and the file has since changed on disk (e.g. during the approval window),
  // refuse to write against the new content rather than silently clobber it.
  const expectedHash = typeof args.expectedHash === 'string' ? args.expectedHash : undefined;
  if (expectedHash && contentHash(original) !== expectedHash) {
    return errorResult(STALE_CONTENT_MESSAGE);
  }

  // #254 BOM preservation: strip a leading UTF-8 BOM before matching/normalizing
  // (so oldText/diff context matches the real body) and re-attach it on write.
  const { bom, body } = splitBom(original);

  // (2) Unified-diff apply — atomic.
  if (hasDiff) {
    // Match in LF space so a CRLF file's trailing \r doesn't make every context
    // line mismatch the (\r-stripped) diff body; restore the original EOL on
    // write. The literal-edits path already did this (#187); the diff path did
    // not, which meant diff apply could never succeed on a CRLF file.
    const diffEol = detectEol(body);
    const normalized = body.replace(/\r\n?/g, '\n');
    let out: { result: string; added: number; removed: number };
    try {
      out = applyUnifiedDiff(normalized, args.diff as string);
    } catch (err) {
      return errorResult(`Diff apply failed: ${err instanceof Error ? err.message : String(err)}. No changes written.`);
    }
    const finalContent = bom + (diffEol === '\r\n' ? out.result.replace(/\n/g, '\r\n') : out.result);
    await fs.writeFile(filePath, finalContent, 'utf8');
    recordTouchedFile(filePath, 'write');
    return dualResult({ path: filePath, applied: true, mode: 'diff', diff: { added: out.added, removed: out.removed } });
  }

  // (1) Literal find/replace edits.
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) {
    return errorResult('Provide a non-empty "edits" array of { oldText, newText } or a "diff" string.');
  }

  const gStart = typeof args.startLine === 'number' ? args.startLine : undefined;
  const gEnd = typeof args.endLine === 'number' ? args.endLine : undefined;

  // Match/apply in LF space so CR/CRLF differences between the file on disk and
  // the model-supplied oldText don't produce spurious "not found" errors (#187).
  // The file's original EOL is detected here and restored on write below.
  const eol = detectEol(body);
  let working = body.replace(/\r\n?/g, '\n');
  let applied = 0;
  for (const raw of edits) {
    const edit = raw as { oldText?: unknown; newText?: unknown; startLine?: unknown; endLine?: unknown };
    const oldText = typeof edit.oldText === 'string' ? edit.oldText.replace(/\r\n?/g, '\n') : '';
    const newText = typeof edit.newText === 'string' ? edit.newText.replace(/\r\n?/g, '\n') : '';
    if (!oldText) return errorResult(`Edit #${applied + 1} has an empty "oldText".`);

    const start = typeof edit.startLine === 'number' ? edit.startLine : gStart;
    const end = typeof edit.endLine === 'number' ? edit.endLine : gEnd;
    const scoped = start !== undefined || end !== undefined;

    // Collect every occurrence in LF space, then resolve which one to edit.
    const occurrences: number[] = [];
    for (let p = working.indexOf(oldText); p !== -1; p = working.indexOf(oldText, p + 1)) {
      occurrences.push(p);
    }
    if (occurrences.length === 0) {
      return errorResult(`Edit #${applied + 1}: "oldText" not found in ${filePath}. No changes written.`);
    }

    // startLine/endLine are a disambiguation HINT, not a hard gate: if exactly
    // one occurrence STARTS within the hinted range, use it (this also tolerates
    // a multi-line match that extends past endLine). Otherwise fall back to a
    // whole-file unambiguous match so a slightly-off line estimate never blocks
    // an edit that is otherwise unique (#170 follow-up).
    let idx = -1;
    if (scoped) {
      const { lo, hi } = regionOffsets(working, start, end);
      const inRange = occurrences.filter((p) => p >= lo && p < hi);
      if (inRange.length === 1) idx = inRange[0];
    }
    if (idx === -1) {
      if (occurrences.length === 1) {
        idx = occurrences[0];
      } else {
        return errorResult(
          `Edit #${applied + 1}: "oldText" is ambiguous (appears ${occurrences.length} times); add more surrounding context or a tighter startLine/endLine so exactly one occurrence is in range. No changes written.`
        );
      }
    }
    working = working.slice(0, idx) + newText + working.slice(idx + oldText.length);
    applied += 1;
  }
  const diff = buildLineDiff(body, working);
  // Restore the file's original line-ending style so unchanged lines keep their
  // bytes and we don't rewrite the whole file just because EOLs differ (#187).
  // Re-attach any leading UTF-8 BOM that was stripped before matching (#254).
  const finalContent = bom + (eol === '\r\n' ? working.replace(/\n/g, '\r\n') : working);
  await fs.writeFile(filePath, finalContent, 'utf8');
  recordTouchedFile(filePath, 'write');
  return dualResult({ path: filePath, mode: 'edits', editsApplied: applied, diff });
}

interface DiffOp { tag: ' ' | '-' | '+'; body: string }
interface DiffHunk { oldStart: number; ops: DiffOp[] }

/**
 * Locate where a hunk's "old side" (its context + removed lines, in order)
 * occurs in `origLines`. The unified-diff header's line number is treated as a
 * HINT, not gospel: we prefer a match at the declared position but search
 * outward from it so a stale/estimated line number still applies cleanly (the
 * "fuzz" that GNU patch / `git apply` provide). `minPos` forbids matching before
 * already-consumed lines. A pure-insertion hunk (empty old side) anchors at the
 * hint. Throws when the context genuinely doesn't exist anywhere in the file.
 */
function locateHunk(origLines: string[], oldBlock: string[], hint: number, minPos: number): number {
  if (oldBlock.length === 0) {
    return Math.min(Math.max(hint, minPos), origLines.length);
  }
  const maxStart = origLines.length - oldBlock.length;
  const matchesAt = (start: number): boolean => {
    if (start < minPos || start > maxStart) return false;
    for (let k = 0; k < oldBlock.length; k++) {
      if (origLines[start + k] !== oldBlock[k]) return false;
    }
    return true;
  };
  const clampedHint = Math.max(minPos, hint);
  if (matchesAt(clampedHint)) return clampedHint;
  const radius = Math.max(clampedHint - minPos, maxStart - clampedHint);
  for (let r = 1; r <= radius; r++) {
    if (matchesAt(clampedHint - r)) return clampedHint - r;
    if (matchesAt(clampedHint + r)) return clampedHint + r;
  }
  throw new Error(
    `could not locate hunk near line ${hint + 1}; its context/removed lines do not match the file. First expected line: ${JSON.stringify(oldBlock[0])}`
  );
}

/**
 * Minimal, dependency-free unified-diff applier (issue #170 D1). Parses standard
 * `@@ -oldStart,oldLen +newStart,newLen @@` hunks and applies them atomically:
 * each hunk is RELOCATED to where its context (' ') + removed ('-') lines
 * actually match the original (see locateHunk) rather than trusting the header's
 * line number, so a slightly-off line number no longer hard-fails. Added ('+')
 * lines are inserted; "\ No newline at end of file" markers are ignored. Throws
 * with no partial write when a hunk's context can't be found at all.
 * PRECONDITION: `original` is LF-normalized by the caller.
 */
function applyUnifiedDiff(original: string, diffText: string): { result: string; added: number; removed: number } {
  const origLines = original.split('\n');
  const diffLines = diffText.split(/\r?\n/);
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  // Parse the diff into hunks first so relocation can reason about a whole hunk.
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line === undefined) break;
    const m = hunkHeader.exec(line);
    if (m) {
      cur = { oldStart: parseInt(m[1], 10), ops: [] };
      hunks.push(cur);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      cur = null; // file header — leave the current hunk (if any)
      continue;
    }
    if (!cur) continue; // preamble before the first hunk
    const tag = line.length ? line[0] : ' ';
    const body = line.length ? line.slice(1) : '';
    if (tag === ' ' || tag === '-' || tag === '+') {
      cur.ops.push({ tag, body });
    } else if (tag === '\\') {
      // "\ No newline at end of file" — nothing to apply.
    } else {
      throw new Error(`unexpected diff line: ${JSON.stringify(line)}`);
    }
  }

  if (hunks.length === 0) throw new Error('no unified-diff hunks (@@ ... @@) found');

  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines already consumed/emitted
  let added = 0;
  let removed = 0;

  for (const hunk of hunks) {
    const oldBlock = hunk.ops.filter((o) => o.tag === ' ' || o.tag === '-').map((o) => o.body);
    const pos = locateHunk(origLines, oldBlock, Math.max(0, hunk.oldStart - 1), cursor);
    if (pos < cursor) throw new Error('overlapping or out-of-order hunks');
    while (cursor < pos) {
      out.push(origLines[cursor]);
      cursor++;
    }
    for (const op of hunk.ops) {
      if (op.tag === ' ') {
        out.push(origLines[cursor]);
        cursor++;
      } else if (op.tag === '-') {
        cursor++;
        removed++;
      } else {
        out.push(op.body);
        added++;
      }
    }
  }

  while (cursor < origLines.length) {
    out.push(origLines[cursor]);
    cursor++;
  }
  return { result: out.join('\n'), added, removed };
}

/** Minimal line-level diff summary (added/removed counts). */
function buildLineDiff(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  const bSet = new Map<string, number>();
  for (const line of b) bSet.set(line, (bSet.get(line) ?? 0) + 1);
  const aSet = new Map<string, number>();
  for (const line of a) aSet.set(line, (aSet.get(line) ?? 0) + 1);
  let removed = 0;
  for (const [line, count] of aSet) removed += Math.max(0, count - (bSet.get(line) ?? 0));
  let added = 0;
  for (const [line, count] of bSet) added += Math.max(0, count - (aSet.get(line) ?? 0));
  return { added, removed };
}

async function entryType(full: string): Promise<'file' | 'directory' | 'other'> {
  try {
    const st = await fs.lstat(full);
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'other';
  }
}

async function listDirTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const dirPath = await resolvePath(args.path, roots);
  const names = await fs.readdir(dirPath);
  const entries = await Promise.all(
    names.map(async (name) => {
      const full = path.join(dirPath, name);
      const type = await entryType(full);
      let size = 0;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        /* ignore */
      }
      return { name, type, size };
    })
  );
  entries.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'directory' ? -1 : 1));
  return dualResult({ path: dirPath, entries });
}

interface TreeNode {
  name: string;
  type: 'file' | 'directory' | 'other';
  children?: TreeNode[];
}

async function dirTreeTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const rootPath = await resolvePath(args.path, roots);
  const depth = Math.min(typeof args.depth === 'number' ? Math.max(1, Math.floor(args.depth)) : DEFAULT_TREE_DEPTH, MAX_TREE_DEPTH);
  let count = 0;
  let truncated = false;

  async function walk(dir: string, level: number): Promise<TreeNode[]> {
    if (level > depth || truncated) return [];
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    names.sort((a, b) => a.localeCompare(b));
    const nodes: TreeNode[] = [];
    for (const name of names) {
      if (++count > MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const full = path.join(dir, name);
      const type = await entryType(full);
      const node: TreeNode = { name, type };
      if (type === 'directory' && level < depth) {
        node.children = await walk(full, level + 1);
      }
      nodes.push(node);
    }
    return nodes;
  }

  const tree = await walk(rootPath, 1);
  return dualResult({ path: rootPath, depth, truncated, tree });
}

function pathEnvironmentValue(): string {
  const entry = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path');
  return entry?.[1] ?? '';
}

/** Locate the installer-provided ripgrep without invoking a shell. */
async function resolveRipgrepExecutable(): Promise<string | null> {
  if (ripgrepExecutableForTests !== undefined) return ripgrepExecutableForTests;
  const pathValue = pathEnvironmentValue();
  if (ripgrepCache?.pathValue === pathValue) return ripgrepCache.executable;

  const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
  let executable: string | null = null;
  for (const rawDir of pathValue.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if ((await fs.stat(candidate)).isFile()) {
          executable = candidate;
          break;
        }
      } catch {
        /* not in this PATH directory */
      }
    }
    if (executable) break;
  }
  ripgrepCache = { pathValue, executable };
  return executable;
}

/**
 * Fast content search using ripgrep's machine-readable stream. Hidden and
 * ignored paths remain included to preserve the filesystem tool's historical
 * semantics; callers can still narrow the root path for a smaller search.
 * Returning null asks the caller to use the portable Node fallback.
 */
async function searchContentWithRipgrep(
  executable: string,
  rootPath: string,
  needle: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ matches: SearchMatch[]; truncated: boolean } | null> {
  if (limit <= 0) return { matches: [], truncated: true };
  const args = [
    '--json',
    '--no-config',
    '--fixed-strings',
    '--ignore-case',
    '--hidden',
    '--no-ignore',
    '--max-filesize', String(SEARCH_MAX_FILE_BYTES),
    '--', needle, '.',
  ];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, args, {
      cwd: rootPath,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  activeRipgrepChildren.add(child);

  let spawnError: Error | undefined;
  let cancelled = false;
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderr.length < 8_000) stderr += String(chunk).slice(0, 8_000 - stderr.length);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error: Error) => {
      spawnError = error;
      activeRipgrepChildren.delete(child);
      resolve(null);
    });
    child.once('close', (code: number | null) => {
      activeRipgrepChildren.delete(child);
      resolve(code);
    });
  });
  const onAbort = () => {
    cancelled = true;
    child.kill();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  if (!child.stdout) {
    child.kill();
    await closed;
    signal?.removeEventListener('abort', onAbort);
    return null;
  }

  const matches: SearchMatch[] = [];
  let truncated = false;
  let parseFailed = false;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let event: {
        type?: string;
        data?: {
          path?: { text?: string };
          lines?: { text?: string };
          line_number?: number;
        };
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        parseFailed = true;
        break;
      }
      if (event.type !== 'match') continue;
      const relativePath = event.data?.path?.text;
      const text = event.data?.lines?.text;
      const lineNumber = event.data?.line_number;
      if (typeof relativePath !== 'string' || typeof text !== 'string' || typeof lineNumber !== 'number') {
        continue;
      }
      matches.push({
        path: path.isAbsolute(relativePath) ? path.resolve(relativePath) : path.resolve(rootPath, relativePath),
        line: lineNumber,
        text: text.replace(/\r?\n$/, '').slice(0, 400),
      });
      if (matches.length >= limit) {
        truncated = true;
        child.kill();
        break;
      }
    }
  } finally {
    lines.close();
  }
  if (parseFailed) child.kill();
  const exitCode = await closed;
  signal?.removeEventListener('abort', onAbort);
  if (cancelled) throw new Error('Filesystem search cancelled.');
  // ripgrep uses 0 for matches and 1 for a clean no-match result. A deliberate
  // limit kill is also successful because the requested result budget is full.
  if (spawnError || parseFailed || (!truncated && exitCode !== 0 && exitCode !== 1)) {
    log.debug('ripgrep search failed; using Node fallback', {
      error: spawnError?.message,
      exitCode,
      stderr: stderr.trim(),
    });
    return null;
  }
  return { matches, truncated };
}

/**
 * Portable one-file scanner. One file descriptor provides the stat, binary
 * probe, and text stream; the previous implementation opened every candidate
 * twice in addition to a separate path stat.
 */
async function scanFileContent(
  full: string,
  needle: string,
  onMatch: (match: SearchMatch) => boolean,
  shouldStop: () => boolean,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let stream: ReturnType<Awaited<ReturnType<typeof fs.open>>['createReadStream']> | undefined;
  let lines: readline.Interface | undefined;
  try {
    handle = await fs.open(full, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES || shouldStop()) return;
    const probe = Buffer.alloc(Math.min(8_000, st.size));
    if (probe.length) await handle.read(probe, 0, probe.length, 0);
    if (looksBinary(probe) || shouldStop()) return;

    const lower = needle.toLowerCase();
    stream = handle.createReadStream({ encoding: 'utf8', start: 0, autoClose: false });
    lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of lines) {
      if (shouldStop()) break;
      lineNo++;
      if (line.toLowerCase().includes(lower)
        && !onMatch({ path: full, line: lineNo, text: line.slice(0, 400) })) {
        break;
      }
    }
  } catch {
    // Unreadable or concurrently removed files are skipped, matching the old search behavior.
  } finally {
    lines?.close();
    stream?.destroy();
    await handle?.close().catch(() => undefined);
  }
}

/** Dirent traversal plus a bounded, globally-budgeted content worker pool. */
async function searchWithNode(
  rootPath: string,
  namePattern: string,
  contentPattern: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const nameMatches: SearchMatch[] = [];
  const contentMatches: SearchMatch[] = [];
  const active = new Set<Promise<void>>();
  let nameLimitReached = false;
  let contentLimitReached = false;

  const shouldStopContent = () => signal?.aborted === true || nameLimitReached || contentMatches.length >= limit;
  const scheduleContentScan = async (full: string): Promise<void> => {
    if (!contentPattern || shouldStopContent()) return;
    while (active.size >= SEARCH_CONCURRENCY && !shouldStopContent()) {
      await Promise.race(active);
    }
    if (shouldStopContent()) return;
    const task = scanFileContent(
      full,
      contentPattern,
      (match) => {
        if (contentMatches.length >= limit) return false;
        contentMatches.push(match);
        if (contentMatches.length >= limit) {
          contentLimitReached = true;
          return false;
        }
        return !nameLimitReached;
      },
      shouldStopContent,
    ).finally(() => active.delete(task));
    active.add(task);
  };

  async function walk(dir: string): Promise<void> {
    if (signal?.aborted || nameLimitReached || (!namePattern && contentLimitReached)) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted || nameLimitReached || (!namePattern && contentLimitReached)) return;
      const full = path.join(dir, entry.name);
      if (namePattern && entry.name.toLowerCase().includes(namePattern)) {
        nameMatches.push({ path: full });
        if (nameMatches.length >= limit) {
          nameLimitReached = true;
          return;
        }
      }

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      // Dirent normally carries the type on Windows/macOS/Linux. Fall back only
      // for filesystems that report an unknown type; never follow symlinks.
      if (!isDirectory && !isFile && !entry.isSymbolicLink()) {
        const type = await entryType(full);
        isDirectory = type === 'directory';
        isFile = type === 'file';
      }
      if (isDirectory) {
        await walk(full);
      } else if (isFile && contentPattern && !contentLimitReached) {
        await scheduleContentScan(full);
      }
    }
  }

  await walk(rootPath);
  await Promise.all(active);
  const matches = [...nameMatches, ...contentMatches].slice(0, limit);
  return {
    matches,
    truncated: nameLimitReached || contentLimitReached || nameMatches.length + contentMatches.length >= limit,
  };
}

async function searchTool(
  args: Record<string, unknown>,
  roots: string[],
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (signal?.aborted) throw new Error('Filesystem search cancelled.');
  const rootPath = await resolvePath(args.path, roots);
  const namePattern = typeof args.namePattern === 'string' ? args.namePattern.toLowerCase() : '';
  const contentPattern = typeof args.content === 'string' ? args.content : '';
  if (!namePattern && !contentPattern) {
    return errorResult('Provide "namePattern" and/or "content" to search for.');
  }

  const ripgrep = contentPattern ? await resolveRipgrepExecutable() : null;
  if (!ripgrep) {
    const result = await searchWithNode(rootPath, namePattern, contentPattern, MAX_SEARCH_RESULTS, signal);
    if (signal?.aborted) throw new Error('Filesystem search cancelled.');
    return dualResult(result);
  }

  // Name matches retain their historical priority in the combined response.
  const names = namePattern
    ? await searchWithNode(rootPath, namePattern, '', MAX_SEARCH_RESULTS, signal)
    : { matches: [] as SearchMatch[], truncated: false };
  if (signal?.aborted) throw new Error('Filesystem search cancelled.');
  if (names.truncated) return dualResult(names);

  const remaining = MAX_SEARCH_RESULTS - names.matches.length;
  const content = await searchContentWithRipgrep(ripgrep, rootPath, contentPattern, remaining, signal);
  if (content) {
    return dualResult({
      matches: [...names.matches, ...content.matches],
      truncated: content.truncated || names.matches.length + content.matches.length >= MAX_SEARCH_RESULTS,
    });
  }

  const fallback = await searchWithNode(rootPath, '', contentPattern, remaining, signal);
  if (signal?.aborted) throw new Error('Filesystem search cancelled.');
  return dualResult({
    matches: [...names.matches, ...fallback.matches],
    truncated: fallback.truncated || names.matches.length + fallback.matches.length >= MAX_SEARCH_RESULTS,
  });
}

async function getFileInfoTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const target = await resolvePath(args.path, roots);
  const st = await fs.stat(target);
  return dualResult({
    path: target,
    type: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other',
    size: st.size,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    createdAt: st.birthtime.toISOString(),
    modifiedAt: st.mtime.toISOString(),
  });
}

async function createDirectoryTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const dirPath = await resolvePath(args.path, roots);
  await fs.mkdir(dirPath, { recursive: true });
  return dualResult({ path: dirPath, created: true });
}

async function moveTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const source = await resolvePath(args.source, roots);
  const destination = await resolvePath(args.destination, roots);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return dualResult({ source, destination });
}

async function deleteTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const target = await resolvePath(args.path, roots);
  const recursive = args.recursive === true;
  await fs.rm(target, { recursive, force: false });
  return dualResult({ path: target, deleted: true });
}

async function getAllowedDirectoriesTool(
  roots: string[]
): Promise<CallToolResult> {
  return dualResult({ directories: roots });
}

export async function filesystemCallTool(
  toolName: string,
  args: Record<string, unknown>,
  callerNodeId?: string,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    // MCP App launcher (#97): pure UI trigger — returns immediately without
    // touching the filesystem. The app renders in chat; the user's pick returns
    // as a follow-up message. Handled before roots are resolved (it needs none).
    if (toolName === 'file_browser_ui') {
      return textResult(
        'File browser shown to the user. Waiting for them to select a file — their choice will arrive as a follow-up message. Do not proceed until then.',
      );
    }
    const roots = await loadEffectiveRoots(FILESYSTEM_SERVER_NAME, 'FLUJO_FS_ROOTS', callerNodeId);
    switch (toolName) {
      case 'read_file':
        return await readFileTool(args, roots);
      case 'write_file':
        return await writeFileTool(args, roots);
      case 'edit_file':
        return await editFileTool(args, roots);
      case 'list_dir':
        return await listDirTool(args, roots);
      case 'dir_tree':
        return await dirTreeTool(args, roots);
      case 'search':
        return await searchTool(args, roots, signal);
      case 'get_file_info':
        return await getFileInfoTool(args, roots);
      case 'create_directory':
        return await createDirectoryTool(args, roots);
      case 'move':
        return await moveTool(args, roots);
      case 'delete':
        return await deleteTool(args, roots);
      case 'get_allowed_directories':
        return await getAllowedDirectoriesTool(roots);
      default:
        return errorResult(`Unknown tool on the built-in filesystem server: ${toolName}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('filesystemCallTool failed', { toolName, err });
    // Do not attach structuredContent to an error. Every successful tool has
    // its own outputSchema, and `{ error }` does not conform to those schemas;
    // strict MCP clients validate it before the file-browser View can inspect
    // `isError`. The JSON text block remains machine-readable by payloadOf().
    return errorResult(msg);
  }
}
