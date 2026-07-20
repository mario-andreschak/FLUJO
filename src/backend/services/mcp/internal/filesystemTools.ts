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
import path from 'path';
import { promises as fs } from 'fs';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
import { FILESYSTEM_SERVER_NAME } from './registry';
import { isInside, loadEffectiveRoots } from './confinement';

const log = createLogger('backend/services/mcp/internal/filesystemTools');

/** Output cap so a huge file/listing can't flood the model's context. */
const MAX_READ_CHARS = 200_000;
const MAX_SEARCH_RESULTS = 1_000;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 10;
const MAX_TREE_ENTRIES = 5_000;

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
 * enforce the effective confinement roots when present. Throws on a confinement
 * violation so callers surface a precise error.
 */
function resolvePath(input: unknown, roots: string[] | null): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('Provide "path".');
  const dataDir = getDataDir();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dataDir, raw);

  if (roots) {
    if (!roots.some((root) => isInside(root, resolved))) {
      throw new Error(`Path "${resolved}" is outside the configured filesystem roots.`);
    }
  }
  return resolved;
}

export function filesystemToolDefinitions(): Tool[] {
  const pathProp = { type: 'string', description: 'File or directory path. Relative paths resolve against the FLUJO data directory; absolute paths are used as-is.' };
  return [
    {
      name: 'read_file',
      description:
        'Read a text file and return its content. Optionally read only a line range with "from"/"to" (1-based, inclusive). Returns { path, from, to, totalLines, content, truncated }.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          from: { type: 'number', description: 'Optional 1-based first line to return (inclusive).' },
          to: { type: 'number', description: 'Optional 1-based last line to return (inclusive).' },
        },
        required: ['path'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          from: { type: 'number' },
          to: { type: 'number' },
          totalLines: { type: 'number' },
          truncated: { type: 'boolean' },
          content: { type: 'string' },
        },
        required: ['path', 'from', 'to', 'totalLines', 'truncated', 'content'],
      },
    },
    {
      name: 'write_file',
      description:
        'Create or write a text file (parent directories are created). "mode": "overwrite" (default) replaces the whole file, or a line range when "startLine"/"endLine" (1-based inclusive) are given; "append" adds content at the end; "insert" inserts content before "startLine". Returns { path, bytesWritten, mode, ... }.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          content: { type: 'string', description: 'The content to write/insert/append.' },
          mode: { type: 'string', enum: ['overwrite', 'append', 'insert'], description: 'Write mode (default "overwrite").' },
          startLine: { type: 'number', description: 'For "insert": line to insert before. For "overwrite": first line of the range to replace (1-based).' },
          endLine: { type: 'number', description: 'For "overwrite": last line (inclusive, 1-based) of the range to replace.' },
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
      description:
        'Edit a text file two ways (mutually exclusive): (1) "edits": [{ oldText, newText, startLine?, endLine? }] literal find/replace — each replaces the first (unambiguous) occurrence, optionally scoped to a line range; or (2) "diff": a unified diff string (standard "@@ -a,b +c,d @@" hunks) applied atomically. Fails with no partial write on any mismatch. Returns { path, editsApplied|applied, diff:{added,removed} }.',
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
      name: 'dir_tree',
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
      description:
        'Search a directory tree. Match file/dir NAMES against "namePattern" (substring, case-insensitive) and/or file CONTENT against "content" (substring). Returns { matches: [{ path, line?, text? }], truncated }.',
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

async function readFileTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const filePath = resolvePath(args.path, roots);
  const content = await fs.readFile(filePath, 'utf8');
  const lines = splitLines(content);
  const totalLines = lines.length;

  const hasRange = typeof args.from === 'number' || typeof args.to === 'number';
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
  return dualResult({ path: filePath, from: hasRange ? from : 1, to: hasRange ? to : totalLines, totalLines, truncated, content: out });
}

async function writeFileTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const filePath = resolvePath(args.path, roots);
  const content = typeof args.content === 'string' ? args.content : '';
  const mode = args.mode === 'append' || args.mode === 'insert' ? args.mode : 'overwrite';
  const hasRange = typeof args.startLine === 'number' || typeof args.endLine === 'number';

  await fs.mkdir(path.dirname(filePath), { recursive: true });

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

  if (mode === 'append') {
    const sep = existing.length && !existing.endsWith('\n') && !existing.endsWith('\r\n') ? detectEol(existing) : '';
    const next = existing + sep + content;
    await fs.writeFile(filePath, next, 'utf8');
    return dualResult({ path: filePath, bytesWritten: Buffer.byteLength(next, 'utf8'), mode: 'append' });
  }

  const eol = detectEol(existing);
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const insertLines = content.split(/\r?\n/);
  const total = lines.length;

  if (mode === 'insert') {
    const at = typeof args.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : total + 1;
    const idx = Math.min(at - 1, total);
    lines.splice(idx, 0, ...insertLines);
    const next = lines.join(eol);
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
  const next = lines.join(eol);
  await fs.writeFile(filePath, next, 'utf8');
  return dualResult({ path: filePath, bytesWritten: Buffer.byteLength(next, 'utf8'), mode: 'overwrite', startLine: start, endLine: end, linesReplaced });
}

/**
 * Char offsets [lo, hi) of the 1-based inclusive line range [start, end] within
 * `text`. When both bounds are absent the whole string is returned. Offsets are
 * computed by counting `\n`; a `\r` (CRLF) stays part of the preceding line's
 * length so offsets into the ORIGINAL string remain exact.
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

async function editFileTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const filePath = resolvePath(args.path, roots);
  const hasDiff = typeof args.diff === 'string' && args.diff.trim().length > 0;
  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;

  if (hasDiff && hasEdits) {
    return errorResult('Provide either "diff" or "edits", not both.');
  }

  const original = await fs.readFile(filePath, 'utf8');

  // (2) Unified-diff apply — atomic.
  if (hasDiff) {
    let out: { result: string; added: number; removed: number };
    try {
      out = applyUnifiedDiff(original, args.diff as string);
    } catch (err) {
      return errorResult(`Diff apply failed: ${err instanceof Error ? err.message : String(err)}. No changes written.`);
    }
    await fs.writeFile(filePath, out.result, 'utf8');
    return dualResult({ path: filePath, applied: true, mode: 'diff', diff: { added: out.added, removed: out.removed } });
  }

  // (1) Literal find/replace edits.
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) {
    return errorResult('Provide a non-empty "edits" array of { oldText, newText } or a "diff" string.');
  }

  const gStart = typeof args.startLine === 'number' ? args.startLine : undefined;
  const gEnd = typeof args.endLine === 'number' ? args.endLine : undefined;

  let working = original;
  let applied = 0;
  for (const raw of edits) {
    const edit = raw as { oldText?: unknown; newText?: unknown; startLine?: unknown; endLine?: unknown };
    const oldText = typeof edit.oldText === 'string' ? edit.oldText : '';
    const newText = typeof edit.newText === 'string' ? edit.newText : '';
    if (!oldText) return errorResult(`Edit #${applied + 1} has an empty "oldText".`);

    const start = typeof edit.startLine === 'number' ? edit.startLine : gStart;
    const end = typeof edit.endLine === 'number' ? edit.endLine : gEnd;
    const scoped = start !== undefined || end !== undefined;
    const { lo, hi } = regionOffsets(working, start, end);

    const idx = working.indexOf(oldText, lo);
    if (idx === -1 || idx >= hi || idx + oldText.length > hi) {
      return errorResult(
        `Edit #${applied + 1}: "oldText" not found${scoped ? ' in the specified line range' : ''} in ${filePath}. No changes written.`
      );
    }
    const next = working.indexOf(oldText, idx + 1);
    if (next !== -1 && next < hi && next + oldText.length <= hi) {
      return errorResult(
        `Edit #${applied + 1}: "oldText" is ambiguous (appears more than once${scoped ? ' in the specified line range' : ''}). No changes written.`
      );
    }
    working = working.slice(0, idx) + newText + working.slice(idx + oldText.length);
    applied += 1;
  }
  await fs.writeFile(filePath, working, 'utf8');
  return dualResult({ path: filePath, mode: 'edits', editsApplied: applied, diff: buildLineDiff(original, working) });
}

/**
 * Minimal, dependency-free unified-diff applier (issue #170 D1). Parses standard
 * `@@ -oldStart,oldLen +newStart,newLen @@` hunks and applies them atomically:
 * context (' ') and removed ('-') lines must match the original exactly or the
 * whole apply throws (no partial write). Added ('+') lines are inserted;
 * "\ No newline at end of file" markers are ignored. Throws on any mismatch.
 */
function applyUnifiedDiff(original: string, diffText: string): { result: string; added: number; removed: number } {
  const origLines = original.split('\n');
  const diffLines = diffText.split(/\r?\n/);
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines already consumed/emitted
  let added = 0;
  let removed = 0;
  let sawHunk = false;
  let i = 0;

  while (i < diffLines.length) {
    const line = diffLines[i];
    if (line === undefined) break;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      i++;
      continue;
    }
    const m = hunkHeader.exec(line);
    if (!m) {
      i++;
      continue;
    }
    sawHunk = true;
    const oldStart = parseInt(m[1], 10);
    const hunkStartIdx = Math.max(0, oldStart - 1);
    if (hunkStartIdx < cursor) throw new Error('overlapping or out-of-order hunks');
    while (cursor < hunkStartIdx && cursor < origLines.length) {
      out.push(origLines[cursor]);
      cursor++;
    }
    i++;

    // Consume the hunk body until the next hunk header or file header.
    while (i < diffLines.length && !hunkHeader.test(diffLines[i]) && !diffLines[i].startsWith('--- ')) {
      const hl = diffLines[i];
      const tag = hl.length ? hl[0] : ' ';
      const body = hl.length ? hl.slice(1) : '';
      if (tag === ' ') {
        const expected = origLines[cursor];
        if (expected !== body) {
          throw new Error(`context mismatch at line ${cursor + 1}: expected ${JSON.stringify(expected)}, diff has ${JSON.stringify(body)}`);
        }
        out.push(origLines[cursor]);
        cursor++;
      } else if (tag === '-') {
        const expected = origLines[cursor];
        if (expected !== body) {
          throw new Error(`removed-line mismatch at line ${cursor + 1}: expected ${JSON.stringify(expected)}, diff has ${JSON.stringify(body)}`);
        }
        cursor++;
        removed++;
      } else if (tag === '+') {
        out.push(body);
        added++;
      } else if (tag === '\\') {
        // "\ No newline at end of file" — nothing to apply.
      } else {
        throw new Error(`unexpected diff line: ${JSON.stringify(hl)}`);
      }
      i++;
    }
  }

  if (!sawHunk) throw new Error('no unified-diff hunks (@@ ... @@) found');

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

async function listDirTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const dirPath = resolvePath(args.path, roots);
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

async function dirTreeTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const rootPath = resolvePath(args.path, roots);
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

async function searchTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const rootPath = resolvePath(args.path, roots);
  const namePattern = typeof args.namePattern === 'string' ? args.namePattern.toLowerCase() : '';
  const contentPattern = typeof args.content === 'string' ? args.content.toLowerCase() : '';
  if (!namePattern && !contentPattern) {
    return errorResult('Provide "namePattern" and/or "content" to search for.');
  }
  const matches: Array<{ path: string; line?: number; text?: string }> = [];
  let truncated = false;

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
        let text = '';
        try {
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue; // binary/unreadable
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(contentPattern)) {
            matches.push({ path: full, line: i + 1, text: lines[i].slice(0, 400) });
            if (matches.length >= MAX_SEARCH_RESULTS) { truncated = true; return; }
          }
        }
      }
    }
  }

  await walk(rootPath);
  return dualResult({ matches, truncated });
}

async function getFileInfoTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const target = resolvePath(args.path, roots);
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

async function createDirectoryTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const dirPath = resolvePath(args.path, roots);
  await fs.mkdir(dirPath, { recursive: true });
  return dualResult({ path: dirPath, created: true });
}

async function moveTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const source = resolvePath(args.source, roots);
  const destination = resolvePath(args.destination, roots);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return dualResult({ source, destination });
}

async function deleteTool(args: Record<string, unknown>, roots: string[] | null): Promise<CallToolResult> {
  const target = resolvePath(args.path, roots);
  const recursive = args.recursive === true;
  await fs.rm(target, { recursive, force: false });
  return dualResult({ path: target, deleted: true });
}

export async function filesystemCallTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const roots = await loadEffectiveRoots(FILESYSTEM_SERVER_NAME, 'FLUJO_FS_ROOTS');
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
      default:
        return errorResult(`Unknown tool on the built-in filesystem server: ${toolName}`);
    }
  } catch (err) {
    log.warn('filesystemCallTool failed', { toolName, err });
    return textResult(`Tool failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}
