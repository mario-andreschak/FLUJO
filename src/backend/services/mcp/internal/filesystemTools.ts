/**
 * Built-in `filesystem` MCP server (issue #170).
 *
 * Cross-platform (Windows/macOS/Linux) filesystem access with structured JSON
 * outputs, line-targeted reads, diff-style edits, directory listing/tree, and
 * search. Relative paths resolve against the FLUJO data directory; absolute
 * paths are honored as-is (same host-access posture as the legacy `terminal`
 * tool). When FLUJO_FS_ROOTS is set (path-list separated by the OS path
 * delimiter), every resolved path must live inside one of those roots or the
 * operation is refused — this lets an operator confine the server.
 *
 * Every tool returns a machine-readable JSON envelope in a single text content
 * block (mirroring the existing internal tools), and errors are returned as
 * `isError: true` results rather than thrown.
 */
import path from 'path';
import { promises as fs } from 'fs';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';

const log = createLogger('backend/services/mcp/internal/filesystemTools');

/** Output cap so a huge file/listing can't flood the model's context. */
const MAX_READ_CHARS = 200_000;
const MAX_SEARCH_RESULTS = 1_000;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 10;
const MAX_TREE_ENTRIES = 5_000;

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Configured confinement roots, or null when unconfined (full host access). */
function configuredRoots(): string[] | null {
  const raw = process.env.FLUJO_FS_ROOTS;
  if (!raw || !raw.trim()) return null;
  return raw
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
}

/**
 * Resolve a user-supplied path against the data dir (for relative paths) and
 * enforce the confinement roots when configured. Throws on a confinement
 * violation so callers surface a precise error.
 */
function resolvePath(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('Provide "path".');
  const dataDir = getDataDir();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dataDir, raw);

  const roots = configuredRoots();
  if (roots) {
    const ok = roots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!ok) {
      throw new Error(`Path "${resolved}" is outside the configured filesystem roots (FLUJO_FS_ROOTS).`);
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
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file with the given content (parent directories are created). Returns { path, bytesWritten }.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          content: { type: 'string', description: 'The full new file contents.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description:
        'Apply one or more literal find/replace edits to a text file. Each edit replaces the first occurrence of "oldText" with "newText". Fails (no partial write) if any "oldText" is missing or ambiguous. Returns { path, editsApplied, diff }.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProp,
          edits: {
            type: 'array',
            description: 'List of { oldText, newText } edits applied in order.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text to find.' },
                newText: { type: 'string', description: 'Replacement text.' },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path', 'edits'],
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
    },
    {
      name: 'get_file_info',
      description: 'Stat a path. Returns { path, type, size, isFile, isDirectory, createdAt, modifiedAt }.',
      inputSchema: {
        type: 'object',
        properties: { path: pathProp },
        required: ['path'],
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
    },
  ];
}

function splitLines(content: string): string[] {
  // Keep it simple + cross-platform: normalize CRLF/CR to LF for counting.
  return content.replace(/\r\n?/g, '\n').split('\n');
}

async function readFileTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const filePath = resolvePath(args.path);
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
  return textResult({ path: filePath, from: hasRange ? from : 1, to: hasRange ? to : totalLines, totalLines, truncated, content: out });
}

async function writeFileTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const filePath = resolvePath(args.path);
  const content = typeof args.content === 'string' ? args.content : '';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return textResult({ path: filePath, bytesWritten: Buffer.byteLength(content, 'utf8') });
}

async function editFileTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const filePath = resolvePath(args.path);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return textResult({ error: 'Provide a non-empty "edits" array of { oldText, newText }.' }, true);

  const original = await fs.readFile(filePath, 'utf8');
  let working = original;
  let applied = 0;
  for (const raw of edits) {
    const edit = raw as { oldText?: unknown; newText?: unknown };
    const oldText = typeof edit.oldText === 'string' ? edit.oldText : '';
    const newText = typeof edit.newText === 'string' ? edit.newText : '';
    if (!oldText) return textResult({ error: `Edit #${applied + 1} has an empty "oldText".` }, true);
    const idx = working.indexOf(oldText);
    if (idx === -1) return textResult({ error: `Edit #${applied + 1}: "oldText" not found in ${filePath}. No changes written.` }, true);
    if (working.indexOf(oldText, idx + 1) !== -1) {
      return textResult({ error: `Edit #${applied + 1}: "oldText" is ambiguous (appears more than once). No changes written.` }, true);
    }
    working = working.slice(0, idx) + newText + working.slice(idx + oldText.length);
    applied += 1;
  }
  await fs.writeFile(filePath, working, 'utf8');
  return textResult({ path: filePath, editsApplied: applied, diff: buildLineDiff(original, working) });
}

/** Minimal line-level diff summary (added/removed counts + a small changed sample). */
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

async function listDirTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const dirPath = resolvePath(args.path);
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
  return textResult({ path: dirPath, entries });
}

interface TreeNode {
  name: string;
  type: 'file' | 'directory' | 'other';
  children?: TreeNode[];
}

async function dirTreeTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const rootPath = resolvePath(args.path);
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
  return textResult({ path: rootPath, depth, truncated, tree });
}

async function searchTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const rootPath = resolvePath(args.path);
  const namePattern = typeof args.namePattern === 'string' ? args.namePattern.toLowerCase() : '';
  const contentPattern = typeof args.content === 'string' ? args.content.toLowerCase() : '';
  if (!namePattern && !contentPattern) {
    return textResult({ error: 'Provide "namePattern" and/or "content" to search for.' }, true);
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
  return textResult({ matches, truncated });
}

async function getFileInfoTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const target = resolvePath(args.path);
  const st = await fs.stat(target);
  return textResult({
    path: target,
    type: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other',
    size: st.size,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    createdAt: st.birthtime.toISOString(),
    modifiedAt: st.mtime.toISOString(),
  });
}

async function createDirectoryTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const dirPath = resolvePath(args.path);
  await fs.mkdir(dirPath, { recursive: true });
  return textResult({ path: dirPath, created: true });
}

async function moveTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const source = resolvePath(args.source);
  const destination = resolvePath(args.destination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return textResult({ source, destination });
}

async function deleteTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const target = resolvePath(args.path);
  const recursive = args.recursive === true;
  await fs.rm(target, { recursive, force: false });
  return textResult({ path: target, deleted: true });
}

export async function filesystemCallTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    switch (toolName) {
      case 'read_file':
        return await readFileTool(args);
      case 'write_file':
        return await writeFileTool(args);
      case 'edit_file':
        return await editFileTool(args);
      case 'list_dir':
        return await listDirTool(args);
      case 'dir_tree':
        return await dirTreeTool(args);
      case 'search':
        return await searchTool(args);
      case 'get_file_info':
        return await getFileInfoTool(args);
      case 'create_directory':
        return await createDirectoryTool(args);
      case 'move':
        return await moveTool(args);
      case 'delete':
        return await deleteTool(args);
      default:
        return textResult({ error: `Unknown tool on the built-in filesystem server: ${toolName}` }, true);
    }
  } catch (err) {
    log.warn('filesystemCallTool failed', { toolName, err });
    return textResult({ error: `Tool failed: ${err instanceof Error ? err.message : String(err)}` }, true);
  }
}
