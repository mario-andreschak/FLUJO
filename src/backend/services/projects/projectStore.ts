/**
 * Projects: the folders a workspace works in.
 *
 * A workspace is the configuration (models, MCP servers, agents, chats); a
 * project is a plain folder anywhere on disk — usually a Git repository — that
 * those agents work on. Projects are the workspace's `roots` (so every MCP
 * server keeps receiving them), plus two fields stored beside them in
 * `.workspace.json`:
 *
 *  - `activeProject` — the project new chats start in (the sidebar selection);
 *  - `chatProjects`  — per-chat bindings `{ project, path }`, where `path` is the
 *                      project's main checkout or one of its Git worktrees.
 *
 * A chat without a binding is pinned to the active project the first time an
 * agent needs its folder, so changing the sidebar selection later never moves
 * an existing chat to another folder.
 */
import fs from 'fs/promises';
import path from 'path';
import {
  activeProjectOf,
  assertWorkspaceRoots,
  getCurrentWorkspace,
  readWorkspaceMetadata,
  sameFilesystemPath,
  updateWorkspaceMetadata,
  WorkspaceMutationError,
  type WorkspaceMetadata,
} from '@/utils/workspace';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { shippedDescriptorForConfig } from '@/backend/services/mcp/shippedServers';
import { getConversationStates } from '@/backend/execution/flow/conversationStateRegistry';
import { worktreeContainerFor } from './projectGit';

/** Bindings kept per workspace; the least recently used are dropped first. */
const MAX_CHAT_BINDINGS = 2000;
/** Agent use refreshes a binding's recency at most this often (avoids a write per tool call). */
const BINDING_TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export interface ChatProjectBinding {
  /** The project (one of the workspace roots) the chat belongs to. */
  project: string;
  /** The folder the chat's agents work in: the project or one of its worktrees. */
  path: string;
}

interface StoredBinding extends ChatProjectBinding {
  at: number;
}

export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

function rootsOf(metadata: WorkspaceMetadata): string[] {
  return assertWorkspaceRoots(metadata.roots ?? []);
}

/**
 * The stored bindings as a Map, so a conversation id is never looked up or
 * written as a plain-object property (ids like `constructor` would otherwise
 * read Object.prototype members).
 */
function bindingsOf(metadata: WorkspaceMetadata): Map<string, StoredBinding> {
  const bindings = new Map<string, StoredBinding>();
  const raw = metadata.chatProjects;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bindings;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<StoredBinding> | null;
    if (!isValidConversationId(id) || !entry || typeof entry.project !== 'string' || typeof entry.path !== 'string') continue;
    if (!path.isAbsolute(entry.project) || !path.isAbsolute(entry.path)) continue;
    bindings.set(id, { project: entry.project, path: entry.path, at: typeof entry.at === 'number' ? entry.at : 0 });
  }
  return bindings;
}

/**
 * The bindings to store, capped least recently used first. Bindings to a
 * removed project are kept on purpose: they mark the chat as bound, so it is
 * never silently re-pinned to another project (and they revive if the project
 * is re-added).
 */
function storedBindings(bindings: Map<string, StoredBinding>): Record<string, StoredBinding> {
  const kept = [...bindings]
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_CHAT_BINDINGS);
  return Object.fromEntries(kept);
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export interface ProjectState {
  projects: string[];
  activeProject?: string;
}

/** The current workspace's projects and the one new chats start in. */
export async function loadProjectState(): Promise<ProjectState> {
  const metadata = await readWorkspaceMetadata();
  const projects = rootsOf(metadata);
  return { projects, activeProject: activeProjectOf(metadata, projects) };
}

function requireProject(projects: string[], project: unknown): string {
  const match = typeof project === 'string'
    ? projects.find(root => sameFilesystemPath(root, project))
    : undefined;
  if (!match) throw new WorkspaceMutationError('WORKSPACE_INVALID_ROOTS', 'That folder is not a project of this workspace.');
  return match;
}

/** Make `project` the one new chats start in. */
export async function setActiveProject(project: unknown): Promise<void> {
  await updateWorkspaceMetadata(getCurrentWorkspace(), current => ({
    ...current,
    activeProject: requireProject(rootsOf(current), project),
  }));
}

/** Add a folder as a project (if it is not one already) and make it active. */
export async function addProject(folder: unknown): Promise<string> {
  if (typeof folder !== 'string' || !path.isAbsolute(folder.trim()) || !(await isDirectory(folder.trim()))) {
    throw new WorkspaceMutationError('WORKSPACE_INVALID_ROOTS', 'Choose an existing folder.');
  }
  const resolved = path.normalize(folder.trim());
  let added = resolved;
  await updateWorkspaceMetadata(getCurrentWorkspace(), current => {
    const roots = rootsOf(current);
    const existing = roots.find(root => sameFilesystemPath(root, resolved));
    added = existing ?? resolved;
    return {
      ...current,
      roots: assertWorkspaceRoots(existing ? roots : [...roots, resolved]),
      activeProject: added,
    };
  });
  return added;
}

/** Remove a project from the workspace. The folder itself is never touched. */
export async function removeProject(project: unknown): Promise<void> {
  await updateWorkspaceMetadata(getCurrentWorkspace(), current => {
    const roots = rootsOf(current);
    const target = requireProject(roots, project);
    const remaining = roots.filter(root => root !== target);
    const next: WorkspaceMetadata = { ...current, roots: remaining };
    if (typeof current.activeProject === 'string' && sameFilesystemPath(current.activeProject, target)) {
      delete next.activeProject;
    }
    return next;
  });
}

/**
 * The chat's stored binding, if it still points at a project of this workspace
 * and an existing folder. A vanished worktree falls back to the main checkout.
 */
export async function getChatProject(conversationId: string): Promise<ChatProjectBinding | undefined> {
  return (await readChatBinding(conversationId)).binding;
}

/**
 * The chat's usable binding plus whether it was ever bound. A bound chat whose
 * project is gone has no folder at all rather than the active project's.
 */
export async function readChatBinding(conversationId: string): Promise<{
  /** Whether the chat was ever bound, even to a project that is gone now. */
  stored: StoredBinding | undefined;
  binding: ChatProjectBinding | undefined;
}> {
  if (!isValidConversationId(conversationId)) return { stored: undefined, binding: undefined };
  const metadata = await readWorkspaceMetadata();
  const roots = rootsOf(metadata);
  const stored = bindingsOf(metadata).get(conversationId);
  if (!stored) return { stored, binding: undefined };
  const project = roots.find(root => sameFilesystemPath(root, stored.project));
  if (!project) return { stored, binding: undefined };
  return { stored, binding: { project, path: await isDirectory(stored.path) ? stored.path : project } };
}

/** Mark a binding as used so eviction drops the least recently used chats. */
async function touchChatBinding(conversationId: string): Promise<void> {
  await updateWorkspaceMetadata(getCurrentWorkspace(), current => {
    const bindings = bindingsOf(current);
    const binding = bindings.get(conversationId);
    if (!binding) return current;
    bindings.set(conversationId, { ...binding, at: Date.now() });
    return { ...current, chatProjects: storedBindings(bindings) };
  });
}

/**
 * Bind a chat to a project folder. Callers verify that `folder` is the project
 * or one of its worktrees (see projectGit.isProjectCheckout) before binding.
 */
export async function bindChatProject(conversationId: string, project: unknown, folder?: string): Promise<ChatProjectBinding> {
  if (!isValidConversationId(conversationId)) {
    throw new WorkspaceMutationError('WORKSPACE_INVALID_ROOTS', 'Invalid conversation id.');
  }
  let bound: ChatProjectBinding | undefined;
  await updateWorkspaceMetadata(getCurrentWorkspace(), current => {
    const roots = rootsOf(current);
    const match = requireProject(roots, project);
    bound = { project: match, path: folder ? path.resolve(folder) : match };
    const bindings = bindingsOf(current);
    bindings.set(conversationId, { ...bound, at: Date.now() });
    return { ...current, chatProjects: storedBindings(bindings) };
  });
  return bound!;
}

/**
 * The chat a conversation works for. Subflow lanes and other child runs get
 * their own conversation ids, but their agents work in the folder of the chat
 * that started them (the chain's root), not in whatever the sidebar selects.
 */
function ownerConversationOf(conversationId: string): string {
  const root = getConversationStates().get(conversationId)?.rootConversationId;
  return root && root !== conversationId && isValidConversationId(root) ? root : conversationId;
}

/**
 * The binding a conversation uses: its own when it has one (also a gone
 * project's, which means "no folder"), else its root chat's. `owner` is the
 * conversation that holds (or will hold) the binding.
 */
export async function readEffectiveChatBinding(conversationId: string): Promise<{
  owner: string;
  stored: StoredBinding | undefined;
  binding: ChatProjectBinding | undefined;
}> {
  const own = await readChatBinding(conversationId);
  const owner = own.stored ? conversationId : ownerConversationOf(conversationId);
  if (owner === conversationId) return { owner, ...own };
  return { owner, ...await readChatBinding(owner) };
}

/**
 * Pin an unbound chat to `project`. The check runs inside the serialized write,
 * so a binding the user chose meanwhile is never overwritten by a first use.
 */
async function pinChatProject(conversationId: string, project: string): Promise<void> {
  await updateWorkspaceMetadata(getCurrentWorkspace(), current => {
    const bindings = bindingsOf(current);
    if (bindings.has(conversationId)) return current;
    const match = requireProject(rootsOf(current), project);
    bindings.set(conversationId, { project: match, path: match, at: Date.now() });
    return { ...current, chatProjects: storedBindings(bindings) };
  });
}

/**
 * The folder a chat's agents work in: its binding, else the active project —
 * which is then pinned to the chat so later sidebar changes do not move it.
 * A chat whose bound project was removed is never re-pinned elsewhere; it gets
 * no project folder (the data directory) until the user picks one. Undefined
 * when there is no project to use. Child runs (subflow lanes) use their root
 * chat's folder unless they were bound themselves.
 */
export async function resolveConversationProjectDir(conversationId: string): Promise<string | undefined> {
  const { owner, stored, binding } = await readEffectiveChatBinding(conversationId);
  if (binding) {
    if (Date.now() - stored!.at > BINDING_TOUCH_INTERVAL_MS) {
      await touchChatBinding(owner).catch(() => undefined);
    }
    return binding.path;
  }
  if (stored) return undefined;
  const { activeProject } = await loadProjectState();
  if (!activeProject || !isValidConversationId(owner)) return activeProject;
  try {
    await pinChatProject(owner, activeProject);
    const pinned = await readChatBinding(owner);
    return pinned.binding?.path ?? (pinned.stored ? undefined : activeProject);
  } catch {
    return activeProject;
  }
}

/**
 * The workspace roots MCP servers receive: projects with the active one first,
 * plus each project's `<repo>.worktrees` folder when it exists, so a chat that
 * works in a worktree stays inside the roots when confinement is enabled.
 */
export async function loadWorkspaceProjectRoots(): Promise<string[]> {
  const { projects, activeProject } = await loadProjectState();
  const ordered = activeProject
    ? [activeProject, ...projects.filter(project => project !== activeProject)]
    : projects;
  const roots: string[] = [];
  for (const project of ordered) {
    roots.push(project);
    const container = worktreeContainerFor(project);
    if (await isDirectory(container)) roots.push(container);
  }
  return roots;
}

/** Shipped packages that understand `_meta.flujo.cwd` as their working folder. */
const PROJECT_AWARE_PACKAGES = new Set(['bash', 'filesystem']);

/**
 * The project folder to send with a chat's tool call, only for the local
 * shipped bash/filesystem servers — remote or third-party servers never get
 * host paths through tool-call metadata.
 */
export async function projectDirForToolCall(
  config: MCPServerConfig | null,
  conversationId: string,
): Promise<string | undefined> {
  if (!config || config.transport !== 'stdio' || config.isolation !== undefined || config.trustedHost !== undefined) return undefined;
  const descriptor = shippedDescriptorForConfig(config);
  if (!descriptor || !PROJECT_AWARE_PACKAGES.has(descriptor.packageDirectory)) return undefined;
  try {
    return await resolveConversationProjectDir(conversationId);
  } catch {
    return undefined;
  }
}
