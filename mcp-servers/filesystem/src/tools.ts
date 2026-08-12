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
import { promises as fs, createReadStream } from 'node:fs';
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
 * Resolve a user-supplied path against the data dir (for relative paths) and
 * enforce the effective confinement roots. An empty roots array blocks all access.
 * Throws on a confinement violation so callers surface a precise error.
 */
async function resolvePath(input: unknown, roots: string[]): Promise<string> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('Provide "path".');
  const dataDir = getDataDir();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dataDir, raw);

  if (roots.length === 0 || !roots.some((root) => isInside(root, resolved))) {
    throw new Error(`Path "${resolved}" is outside the configured filesystem roots.`);
  }
  return resolved;
}

export function filesystemToolDefinitions(): Tool[] {
  const pathProp = { type: 'string', description: 'File or directory path. Relative paths resolve against the FLUJO data directory; absolute paths are used as-is.' };
  return [
    {
      name: 'read_file',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        'Read one text file with "path", or up to 25 files in input order with mutually exclusive "paths". Optional "from"/"to" (1-based, inclusive) and "pattern" settings apply to every target. ' +
        `Media files (images, audio, video) are detected automatically and returned as MCP media content items; read them with "path" alone ("pattern"/"from"/"to" do not apply to binary media, and the large-file rule below is waived for them, up to ${MAX_MEDIA_BYTES / (1024 * 1024)} MB). FLUJO persists the bytes as a run resource and re-attaches them to the conversation as a real media input, so a model that accepts that modality perceives the file directly; a model that does not receives the run-resource URI and can still pass it to other tools. ` +
        `For large NON-MEDIA files (> ${LARGE_FILE_BYTES / 1000} KB) read WHOLE (no "from"/"to"), a "pattern" is REQUIRED: the server greps the file and returns only matching lines (with a little surrounding context) so you can follow up with targeted "from"/"to" reads. Pass pattern "*" to force-read the entire large file anyway. ` +
        'Single text reads return { path, from, to, totalLines, content, truncated, contentHash, matches? } unchanged; media reads return { path, mediaType, mimeType, size, encoding } alongside the media item. Batch reads return { files }, with one ordered success or { requestedPath, path?, error } record per input; individual failures do not discard successful reads. Batch output is limited to 1,000,000 serialized characters. Pass contentHash back as "expectedHash" on a follow-up edit_file/write_file to guard against the file changing in between (TOCTOU).',
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
          pattern: { type: 'string', description: 'Case-insensitive substring to grep for. Required to read a large file whole without a "from"/"to" range; matching lines (plus context) are returned instead of the full body. Use "*" to read the whole large file anyway.' },
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
        'Create or write a text file (parent directories are created). "mode": "overwrite" (default) replaces the whole file, or a line range when "startLine"/"endLine" (1-based inclusive) are given; "append" adds content at the end; "insert" inserts content before "startLine". Optionally pass "expectedHash" (the contentHash from a prior read_file) to reject the write if the file changed on disk since it was read (TOCTOU guard); ignored for a whole-file overwrite. Returns { path, bytesWritten, mode, ... }.',
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
        'Edit a text file two ways (mutually exclusive): (1) "edits": [{ oldText, newText, startLine?, endLine? }] literal find/replace — each replaces the unique occurrence of oldText. startLine/endLine are an optional disambiguation HINT (if exactly one match starts in that range it wins); a wrong/missing range still works as long as oldText is unique in the file. Include enough surrounding context to make oldText unique. Or (2) "diff": a unified diff string ("@@ -a,b +c,d @@" hunks) applied atomically — hunks are relocated to where their context actually matches, so slightly-off @@ line numbers still apply, and CRLF files are handled. Fails with no partial write only when text is missing/ambiguous or a hunk context is not found. Optionally pass "expectedHash" (the contentHash from a prior read_file) to reject the edit if the file changed on disk since it was read (TOCTOU guard). Returns { path, editsApplied|applied, diff:{added,removed} }.',
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
      description: 'List the entries of a directory. Returns { path, entries: [{ name, type, size }] } where type is "file" | "directory" | "other".',
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
        'Open an interactive file browser in the chat so the USER can pick a file. This returns IMMEDIATELY without a selection — the browser is shown to the user and the file they choose arrives afterwards as a follow-up user message (e.g. "Selected file: <path>"). After calling this tool you MUST stop and wait for that message; do not guess a path or continue until the user has selected.',
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
      description: 'Return a recursive, depth-limited directory tree as nested JSON. Returns { path, depth, tree }.',
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
        'Search a directory tree. Match file/dir NAMES against "namePattern" (substring, case-insensitive) and/or file CONTENT against "content" (substring, case-insensitive). Content search DOES look inside every text file, returning each matching line with its 1-based line number; likely-binary and very large files are skipped for speed. Returns { matches: [{ path, line?, text? }], truncated }.',
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
      description: 'Stat a path. Returns { path, type, size, isFile, isDirectory, createdAt, modifiedAt }.',
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
      description: 'Create a directory (recursively). Succeeds if it already exists. Returns { path, created }.',
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
      description: 'Move or rename a file/directory from "source" to "destination". Returns { source, destination }.',
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
      description: 'Delete a file or directory. Pass "recursive": true to remove a non-empty directory. Returns { path, deleted }.',
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
        'Returns the list of directories that this filesystem MCP server is ' +
        'currently allowed to access. The list is the merged result of ' +
        'server-level roots (configured via FLUJO MCP settings), MCP-node-level ' +
        'roots (set in the FlowBuilder), and the FLUJO_FS_ROOTS environment ' +
        'variable ceiling. When no roots are configured at all, returns the FLUJO ' +
        'data directory as the default (so the file browser is usable out of the box).',
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

/**
 * Stream a file line-by-line and collect the lines that contain `needle`
 * (case-insensitive substring). Streaming means a match can be found without
 * buffering the whole file. Stops early once `max` matches are collected.
 */
async function grepFileLines(
  filePath: string,
  needle: string,
  max: number
): Promise<{ matches: Array<{ line: number; text: string }>; truncated: boolean }> {
  const lower = needle.toLowerCase();
  const matches: Array<{ line: number; text: string }> = [];
  let truncated = false;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (line.toLowerCase().includes(lower)) {
        matches.push({ line: lineNo, text: line.slice(0, 400) });
        if (matches.length >= max) { truncated = true; break; }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { matches, truncated };
}

async function readSingleFileTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const filePath = await resolvePath(args.path, roots);

  const hasRange = typeof args.from === 'number' || typeof args.to === 'number';
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';

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
    const lower = pattern.toLowerCase();
    const matches: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
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

/**
 * #287: content-scan one file for `needle`. Skips oversized and likely-binary
 * files up front (a huge perf/robustness win over reading every file whole),
 * then streams it line-by-line so a match is found without buffering the file.
 */
async function scanFileContent(
  full: string,
  needle: string,
  remaining: number
): Promise<Array<{ path: string; line: number; text: string }>> {
  let st: import('fs').Stats;
  try {
    st = await fs.stat(full);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES) return [];
  // Binary sniff on the first chunk without loading the whole file.
  try {
    const fh = await fs.open(full, 'r');
    try {
      const probe = Buffer.alloc(Math.min(8000, st.size));
      if (probe.length) await fh.read(probe, 0, probe.length, 0);
      if (looksBinary(probe)) return [];
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
  const { matches } = await grepFileLines(full, needle, Math.max(1, remaining));
  return matches.map((m) => ({ path: full, line: m.line, text: m.text }));
}

async function searchTool(args: Record<string, unknown>, roots: string[]): Promise<CallToolResult> {
  const rootPath = await resolvePath(args.path, roots);
  const namePattern = typeof args.namePattern === 'string' ? args.namePattern.toLowerCase() : '';
  const contentPattern = typeof args.content === 'string' ? args.content : '';
  if (!namePattern && !contentPattern) {
    return errorResult('Provide "namePattern" and/or "content" to search for.');
  }
  const matches: Array<{ path: string; line?: number; text?: string }> = [];
  let truncated = false;

  // First pass: walk the tree collecting NAME matches immediately and gathering
  // the list of candidate files for a (possibly parallel) content scan.
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      const full = path.join(dir, name);
      const type = await entryType(full);
      if (namePattern && name.toLowerCase().includes(namePattern)) {
        matches.push({ path: full });
        if (matches.length >= MAX_SEARCH_RESULTS) { truncated = true; return; }
      }
      if (type === 'directory') {
        await walk(full);
      } else if (type === 'file' && contentPattern) {
        files.push(full);
      }
    }
  }
  await walk(rootPath);

  // Second pass: scan file contents with bounded concurrency and early stop.
  if (contentPattern && !truncated) {
    for (let i = 0; i < files.length && !truncated; i += SEARCH_CONCURRENCY) {
      const batch = files.slice(i, i + SEARCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map((full) => scanFileContent(full, contentPattern, MAX_SEARCH_RESULTS))
      );
      for (const fileMatches of results) {
        for (const m of fileMatches) {
          matches.push(m);
          if (matches.length >= MAX_SEARCH_RESULTS) { truncated = true; break; }
        }
        if (truncated) break;
      }
    }
  }

  return dualResult({ matches, truncated });
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

export async function filesystemCallTool(toolName: string, args: Record<string, unknown>, callerNodeId?: string): Promise<CallToolResult> {
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
        return await searchTool(args, roots);
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
