import path from 'path';
import fs from 'fs/promises';
import { lstatSync, readdirSync } from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { fileURLToPath, pathToFileURL } from 'url';
import { getDataDir } from './paths';

/**
 * Workspaces (#406) — a logical namespace *beneath* the existing FLUJO data root.
 *
 * The on-disk layout is:
 *
 *   <FLUJO_DATA_DIR or app root>/          <- getDataDir(), the "parent root"
 *     workspaces/
 *       default-workspace/
 *         db/
 *         mcp-servers/
 *         userdata/
 *         snapshots/, screenshots/, recordings/
 *         browser-profile/, bash-utils/, artifacts/
 *       <other-workspace>/
 *         db/
 *         mcp-servers/
 *         userdata/
 *         snapshots/, screenshots/, recordings/
 *         browser-profile/, bash-utils/, artifacts/
 *
 * `FLUJO_DATA_DIR` keeps its existing meaning (the parent root) so Docker/npx
 * installs are unaffected; only the *inner* layout gains one extra level.
 *
 * Two rules keep this safe against the classic multi-tenant bugs:
 *
 *  1. A workspace is an **identifier**, never a path. Names are validated against
 *     a conservative allowlist and the resolved directory is containment-checked
 *     against `workspaces/`, so no caller-supplied string can escape the root.
 *  2. The selected workspace is carried in an `AsyncLocalStorage` context, not in
 *     a mutable module-global. Two concurrent requests for different workspaces
 *     therefore resolve to distinct trees without either one "winning" and making
 *     the process sticky to whichever workspace was resolved first.
 */

export const DEFAULT_WORKSPACE = 'default-workspace';

/**
 * Conservative allowlist: must start alphanumeric, then alphanumerics, `_` or `-`,
 * 1..64 characters total. This rejects (by construction) empty values, `.`, `..`,
 * `/`, `\`, drive letters, UNC prefixes, control characters, whitespace, and the
 * `%2e%2e` family — a percent sign is simply not in the allowlist.
 */
export const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Windows reserves these basenames even below an ordinary directory. */
const WINDOWS_RESERVED_WORKSPACE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Every top-level runtime subtree owned by a workspace. */
export const WORKSPACE_SUBTREES = [
  'db',
  'mcp-servers',
  'userdata',
  'snapshots',
  'screenshots',
  'recordings',
  'browser-profile',
  'bash-utils',
  'artifacts',
] as const;
export type WorkspaceSubtree = (typeof WORKSPACE_SUBTREES)[number];

/**
 * Thrown for a syntactically invalid workspace name. Routes translate this into
 * an HTTP 400 — as opposed to an unknown-but-valid name, which is a 404, and a
 * genuine filesystem failure, which is a 500.
 */
export class InvalidWorkspaceNameError extends Error {
  readonly code = 'INVALID_WORKSPACE_NAME';
  readonly value: unknown;

  constructor(value: unknown) {
    super(
      `Invalid workspace name: ${JSON.stringify(value)}. ` +
        'Workspace names must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/ ' +
        'and must not be a reserved Windows device name.',
    );
    this.name = 'InvalidWorkspaceNameError';
    this.value = value;
  }
}

export function isValidWorkspaceName(value: unknown): value is string {
  return typeof value === 'string'
    && WORKSPACE_NAME_PATTERN.test(value)
    && !WINDOWS_RESERVED_WORKSPACE_NAME.test(value);
}

/** Validate and return the name, or throw {@link InvalidWorkspaceNameError}. */
export function assertValidWorkspaceName(value: unknown): string {
  if (!isValidWorkspaceName(value)) throw new InvalidWorkspaceNameError(value);
  return value;
}

/**
 * Resolve an *optional* caller-supplied workspace to a validated name.
 * `undefined`, `null` and `''` all mean "the caller did not choose" and select
 * the default workspace — this is what keeps every pre-#406 caller working.
 * Anything else must be a syntactically valid name.
 */
export function normalizeWorkspaceName(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_WORKSPACE;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_WORKSPACE;
  return assertValidWorkspaceName(value);
}

/** `<data root>/workspaces` — the only place workspace trees may live. */
export function getWorkspacesDir(): string {
  return path.join(getDataDir(), 'workspaces');
}

/**
 * `<data root>/workspaces/<name>`, validated *and* containment-checked. The
 * second check is redundant given the allowlist, but it is cheap and it means a
 * future loosening of the pattern cannot silently become a traversal bug.
 */
export function getWorkspaceDir(workspace?: string): string {
  const name = normalizeWorkspaceName(workspace);
  const root = getWorkspacesDir();
  const resolved = path.resolve(root, name);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InvalidWorkspaceNameError(workspace);
  }
  return resolved;
}

/**
 * The data root *for the selected workspace*. This is the drop-in replacement for
 * `getDataDir()` at every call site that builds a path to workspace-owned data
 * (all entries in WORKSPACE_SUBTREES and everything derived from them). Call sites
 * that mean "the FLUJO installation root" must keep using `getDataDir()`.
 */
export function getWorkspaceDataDir(workspace?: string): string {
  return getWorkspaceDir(workspace ?? getCurrentWorkspace());
}

export function getWorkspaceDbDir(workspace?: string): string {
  return path.join(getWorkspaceDataDir(workspace), 'db');
}

export function getWorkspaceMcpServersDir(workspace?: string): string {
  return path.join(getWorkspaceDataDir(workspace), 'mcp-servers');
}

export function getWorkspaceUserdataDir(workspace?: string): string {
  return path.join(getWorkspaceDataDir(workspace), 'userdata');
}

/**
 * Remap an absolute path persisted before workspaces when the migration state
 * proves that its legacy owner moved into the default workspace. Ambiguous or
 * explicitly external paths are returned unchanged.
 */
export function remapLegacyDefaultWorkspacePath(
  candidate: string,
  subtree: WorkspaceSubtree,
): string {
  if (
    typeof candidate !== 'string'
    || !path.isAbsolute(candidate)
    || getCurrentWorkspace() !== DEFAULT_WORKSPACE
  ) return candidate;

  const legacyRoot = path.join(getDataDir(), subtree);
  const relative = path.relative(legacyRoot, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return candidate;

  const [owner] = relative.split(path.sep);
  if (!owner) return candidate;
  const legacyOwner = path.join(legacyRoot, owner);
  const migratedOwner = path.join(getWorkspaceDataDir(DEFAULT_WORKSPACE), subtree, owner);
  let legacyOwnerHasAuthority = false;
  try {
    const stat = lstatSync(legacyOwner);
    // A retained EBUSY/EXDEV mount can remain as an empty real directory. Any
    // other surviving object is still authoritative and therefore ambiguous.
    legacyOwnerHasAuthority = !stat.isDirectory()
      || stat.isSymbolicLink()
      || readdirSync(legacyOwner).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') legacyOwnerHasAuthority = true;
  }
  let migratedOwnerIsSafe = false;
  try {
    const stat = lstatSync(migratedOwner);
    migratedOwnerIsSafe = !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
  } catch {
    migratedOwnerIsSafe = false;
  }
  if (legacyOwnerHasAuthority || !migratedOwnerIsSafe) return candidate;
  return path.join(getWorkspaceDataDir(DEFAULT_WORKSPACE), subtree, relative);
}

/** Remap complete path-bearing config values without parsing shell commands. */
export function remapLegacyDefaultWorkspaceReference(
  candidate: string,
  subtree: WorkspaceSubtree,
): string {
  const direct = remapLegacyDefaultWorkspacePath(candidate, subtree);
  if (direct !== candidate) return direct;

  try {
    const url = new URL(candidate);
    if (url.protocol === 'file:') {
      const originalPath = fileURLToPath(url);
      const remappedPath = remapLegacyDefaultWorkspacePath(originalPath, subtree);
      if (remappedPath !== originalPath) {
        const remappedUrl = pathToFileURL(remappedPath);
        remappedUrl.search = url.search;
        remappedUrl.hash = url.hash;
        return remappedUrl.href;
      }
    }
  } catch {
    // Not a complete URL; it may still be a flag assignment below.
  }

  const equals = candidate.indexOf('=');
  if (equals <= 0 || equals === candidate.length - 1) return candidate;
  const prefix = candidate.slice(0, equals + 1);
  let value = candidate.slice(equals + 1);
  let quote = '';
  if (
    value.length >= 2
    && (value[0] === '"' || value[0] === "'")
    && value.at(-1) === value[0]
  ) {
    quote = value[0];
    value = value.slice(1, -1);
  }
  const remappedValue = remapLegacyDefaultWorkspaceReference(value, subtree);
  return remappedValue === value
    ? candidate
    : `${prefix}${quote}${remappedValue}${quote}`;
}

/**
 * The ambient workspace for the current async execution context.
 *
 * Stored on `globalThis` because Next.js can evaluate a module more than once
 * (route bundles, hot reload, instrumentation); a second `AsyncLocalStorage`
 * instance would silently lose the context established by the first.
 */
declare global {
  var __flujo_workspace_als: AsyncLocalStorage<string> | undefined;
}

function store(): AsyncLocalStorage<string> {
  if (!global.__flujo_workspace_als) {
    global.__flujo_workspace_als = new AsyncLocalStorage<string>();
  }
  return global.__flujo_workspace_als;
}

/**
 * The workspace selected for the current request/task, or `default-workspace`
 * outside of any workspace context (startup, background jobs, plain scripts).
 */
export function getCurrentWorkspace(): string {
  const current = store().getStore();
  return current && isValidWorkspaceName(current) ? current : DEFAULT_WORKSPACE;
}

/**
 * Run `fn` with `workspace` as the ambient selection. Everything awaited inside —
 * including detached-but-awaited service calls — sees the same workspace, and
 * nothing outside is affected. Validates first, so an invalid name can never be
 * installed as a context.
 */
export function runWithWorkspace<T>(workspace: string | undefined, fn: () => T): T {
  const name = normalizeWorkspaceName(workspace);
  return store().run(name, fn);
}

/**
 * Bind `fn` to the *currently* selected workspace, so a callback that escapes the
 * request context (a timer, an event-bus listener, a queued job) keeps operating
 * on the workspace it was created for instead of falling back to the default.
 */
export function bindToCurrentWorkspace<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const workspace = getCurrentWorkspace();
  return (...args: A) => runWithWorkspace(workspace, () => fn(...args));
}

/**
 * A cache key prefix for the selected workspace. Every process-wide cache, write
 * chain or registry keyed by an id that is only unique *within* a workspace
 * (conversation id, MCP server name, KV scope, ...) must include this, otherwise
 * workspace A can serve workspace B's cached value.
 */
export function workspaceCacheKey(...parts: string[]): string {
  return [getCurrentWorkspace(), ...parts].join('\u0000');
}

/**
 * Deterministic tab colors. Derived from the name so no mutable colour metadata
 * store is needed (#406 does not ask for one) and so a workspace keeps its colour
 * across restarts, machines and browsers.
 */
export const WORKSPACE_COLORS = [
  '#6656E8',
  '#10A8C3',
  '#2E9E5B',
  '#D2761B',
  '#C2417E',
  '#7A57C9',
  '#1F86D0',
  '#B4453A',
] as const;

export function workspaceColorIndex(workspace: string): number {
  // FNV-1a: tiny, stable across platforms, and good enough for palette spread.
  let hash = 0x811c9dc5;
  for (let i = 0; i < workspace.length; i++) {
    hash ^= workspace.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % WORKSPACE_COLORS.length;
}

export function workspaceColor(workspace: string): string {
  if (workspace === DEFAULT_WORKSPACE) return WORKSPACE_COLORS[0];
  return WORKSPACE_COLORS[workspaceColorIndex(workspace)];
}

export interface WorkspaceInfo {
  name: string;
  color: string;
  isDefault: boolean;
}

/**
 * Enumerate the workspaces that actually exist on disk.
 *
 * Entries that are not directories, or whose names fail validation, are ignored
 * rather than reported — a stray file or a hand-created `../evil` style name must
 * never become a selectable workspace. Symlinked entries are resolved and
 * containment-checked so a symlink cannot smuggle in an out-of-tree directory.
 * `default-workspace` is always included, even before it has been created, so the
 * UI always has a valid selection.
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const root = getWorkspacesDir();
  const names = new Set<string>([DEFAULT_WORKSPACE]);

  type WorkspaceDirent = {
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
  let entries: WorkspaceDirent[] = [];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })) as unknown as WorkspaceDirent[];
  } catch (error) {
    // No workspaces directory yet (fresh install, or migration not run): the
    // default workspace is still the correct answer.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else throw error;
  }

  const aliases = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isValidWorkspaceName(entry.name)) continue;
    const folded = entry.name.toLowerCase();
    const group = aliases.get(folded) ?? [];
    group.push(entry.name);
    aliases.set(folded, group);
  }

  for (const entry of entries) {
    if (!isValidWorkspaceName(entry.name)) continue;
    if ((aliases.get(entry.name.toLowerCase())?.length ?? 0) > 1) continue;
    if (entry.isDirectory()) {
      names.add(entry.name);
      continue;
    }
    // Workspace roots must be real directories, never symlinks or junctions.
    if (entry.isSymbolicLink()) continue;
  }

  return [...names]
    .sort((a, b) => {
      if (a === DEFAULT_WORKSPACE) return -1;
      if (b === DEFAULT_WORKSPACE) return 1;
      return a.localeCompare(b);
    })
    .map(name => ({
      name,
      color: workspaceColor(name),
      isDefault: name === DEFAULT_WORKSPACE,
    }));
}

/** Whether a (syntactically valid) workspace exists on disk. */
export async function workspaceExists(workspace: string): Promise<boolean> {
  if (!isValidWorkspaceName(workspace)) return false;
  try {
    const entries = await fs.readdir(getWorkspacesDir(), { withFileTypes: true });
    const aliases = entries.filter(entry =>
      isValidWorkspaceName(entry.name)
      && entry.name.toLowerCase() === workspace.toLowerCase(),
    );
    if (aliases.length !== 1 || aliases[0].name !== workspace) return false;
    const stat = await fs.lstat(getWorkspaceDir(workspace));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertRealDirectory(candidate: string, label: string): Promise<void> {
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a file, symlink, or junction: ${candidate}`);
  }
}

/** Create the complete workspace-owned directory set if missing. Idempotent. */
export async function ensureWorkspaceDirs(workspace?: string): Promise<string> {
  const dir = getWorkspaceDir(workspace);
  const dataRoot = getDataDir();
  const workspacesRoot = getWorkspacesDir();
  await fs.mkdir(dataRoot, { recursive: true });
  await assertRealDirectory(dataRoot, 'FLUJO data root');
  await fs.mkdir(workspacesRoot, { recursive: true });
  await assertRealDirectory(workspacesRoot, 'Workspaces root');

  const expectedName = path.basename(dir);
  const siblings = await fs.readdir(workspacesRoot);
  const aliases = siblings.filter(name =>
    isValidWorkspaceName(name) && name.toLowerCase() === expectedName.toLowerCase(),
  );
  if (aliases.some(name => name !== expectedName) || aliases.length > 1) {
    throw new Error(
      `Workspace name ${JSON.stringify(expectedName)} conflicts with a case alias on disk: ` +
      aliases.join(', '),
    );
  }

  await fs.mkdir(dir, { recursive: true });
  await assertRealDirectory(dir, `Workspace ${expectedName}`);
  const canonicalRoot = await fs.realpath(workspacesRoot);
  const canonicalWorkspace = await fs.realpath(dir);
  const rel = path.relative(canonicalRoot, canonicalWorkspace);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Workspace directory escapes the workspaces root: ${dir}`);
  }
  for (const sub of WORKSPACE_SUBTREES) {
    const subtree = path.join(dir, sub);
    await fs.mkdir(subtree, { recursive: true });
    await assertRealDirectory(subtree, `Workspace subtree ${sub}`);
  }
  return dir;
}
