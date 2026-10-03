import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir, isValidWorkspaceName } from '@/utils/workspace';
import { ownerPolicySchema } from '../security/ownerCredentials';
import {
  createIsolatedMcpLaunch, isolatedMcpPolicyDigest, isolatedMcpPolicySchema, McpIsolationError,
  type IsolatedMcpLaunch,
} from '../security/isolatedMcp';

const MAX_POLICY_BYTES = 64 * 1024;
const approvalSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  approvals: z.array(z.object({
    workspace: z.string().refine(isValidWorkspaceName),
    serverName: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(128),
}).strict().refine(value => new Set(value.approvals.map(item => JSON.stringify([item.workspace, item.serverName]))).size === value.approvals.length);

function readPrivatePolicy(filename: string | undefined): unknown {
  if (filename === undefined || !path.isAbsolute(filename.trim())) throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  const fd = openSync(filename.trim(), 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES
        || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    const bytes = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_POLICY_BYTES) throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
}

export function approvedIsolationDigest(config: MCPStdioConfig, workspace = getCurrentWorkspace()): string {
  try {
    const policy = isolatedMcpPolicySchema.parse(config.isolation);
    if (JSON.stringify(policy.command) !== JSON.stringify([config.command, ...(config.args ?? [])])
        || config.enableMcpApps || config.enableMcpSkills || config.sampling?.enabled || config.elicitation?.enabled) {
      throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    }
    const approvals = approvalSchema.parse(readPrivatePolicy(process.env.FLUJO_MCP_ISOLATION_FILE));
    const owner = ownerPolicySchema.parse(readPrivatePolicy(process.env.FLUJO_OWNER_AUTH_FILE));
    const approved = approvals.approvals.find(item => item.workspace === workspace && item.serverName === config.name);
    const digest = isolatedMcpPolicyDigest(policy);
    if (owner.ownerId !== approvals.ownerId || !approved || approved.expiresAt <= Date.now()
        || approved.policyDigest !== digest) throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
    return digest;
  } catch (error) {
    if (error instanceof McpIsolationError) throw error;
    throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  }
}

/** A private isolation grant cannot be bypassed by omitting it from an imported config. */
export function assertHostMcpLaunchAllowed(config: MCPStdioConfig): void {
  if (process.env.FLUJO_MCP_ISOLATION_FILE === undefined) return;
  try {
    const approvals = approvalSchema.parse(readPrivatePolicy(process.env.FLUJO_MCP_ISOLATION_FILE));
    if (approvals.approvals.some(item => item.workspace === getCurrentWorkspace() && item.serverName === config.name)) {
      throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
    }
  } catch (error) {
    if (error instanceof McpIsolationError) throw error;
    throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  }
}

export interface ManagedMcpIsolation {
  readonly launch: IsolatedMcpLaunch;
  readonly policyDigest: string;
  readonly workspace: string;
  readonly serverName: string;
  readonly cleanupPending: boolean;
  close(): ReturnType<IsolatedMcpLaunch['close']>;
}

declare global {
  var __flujo_mcp_isolated_generations: Map<string, ManagedMcpIsolation> | undefined;
}

function registry(): Map<string, ManagedMcpIsolation> {
  return global.__flujo_mcp_isolated_generations ??= new Map();
}

export function prepareMcpIsolation(config: MCPStdioConfig, environment: Record<string, string>): ManagedMcpIsolation {
  const workspace = getCurrentWorkspace();
  const policyDigest = approvedIsolationDigest(config, workspace);
  const key = JSON.stringify([workspace, config.name]);
  const predecessor = registry().get(key);
  if (predecessor && (!predecessor.cleanupPending || predecessor.close().outcome === 'unknown')) {
    throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  }
  const workspaceRoot = path.resolve(getWorkspaceDataDir());
  const ownershipKey = createHash('sha256').update(JSON.stringify([
    process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot, config.name,
  ])).digest('hex');
  const launch = createIsolatedMcpLaunch(config.isolation, policyDigest, workspaceRoot, environment, { key: ownershipKey });
  let cleanupPending = false;
  const managed: ManagedMcpIsolation = Object.freeze({ launch, policyDigest, workspace, serverName: config.name,
    get cleanupPending() { return cleanupPending; },
    close: () => {
      cleanupPending = true;
      const result = launch.close();
      if (result.outcome !== 'unknown' && registry().get(key) === managed) registry().delete(key);
      return result;
    },
  });
  registry().set(key, managed);
  return managed;
}

/** Override SDK defaults as well as explicit values; the CLI needs no account home/PATH. */
export function isolatedSdkEnvironment(launch: IsolatedMcpLaunch): Record<string, string> {
  const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(name => [name, '']));
  Object.assign(env, launch.env);
  if (process.platform === 'win32') env.SYSTEMROOT = launch.env.SystemRoot || 'C:\\Windows';
  return env;
}

interface IsolationTransport {
  __flujoMcpIsolation?: ManagedMcpIsolation;
  __flujoInnerTransport?: unknown;
  start(): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
}

export function getManagedMcpIsolation(transport: unknown): ManagedMcpIsolation | undefined {
  const seen = new Set<unknown>();
  let current = transport;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as IsolationTransport;
    if (candidate.__flujoMcpIsolation) return candidate.__flujoMcpIsolation;
    current = candidate.__flujoInnerTransport;
  }
  return undefined;
}

/** V1 has environment grants, not grants to interpolate the host secret store into tool maps. */
export function assertIsolatedMcpArguments(value: unknown): void {
  const seen = new Set<object>();
  let visited = 0;
  function visit(item: unknown, depth: number): void {
    if (++visited > 4096 || depth > 32) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    if (typeof item === 'string' && item.includes('${global:')) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
      seen.add(item);
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  }
  visit(value, 0);
}

export function attachMcpIsolation(transport: IsolationTransport, config: MCPStdioConfig, managed: ManagedMcpIsolation): void {
  transport.__flujoMcpIsolation = managed;
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  const wrapClose = (callback: (() => void) | undefined) => () => { managed.close(); callback?.(); };
  let onclose = wrapClose(transport.onclose);
  Object.defineProperty(transport, 'onclose', { configurable: true,
    get: () => onclose,
    set: (callback: (() => void) | undefined) => { onclose = wrapClose(callback); },
  });
  transport.start = async () => {
    try {
      if (getCurrentWorkspace() !== managed.workspace || approvedIsolationDigest(config, managed.workspace) !== managed.policyDigest) {
        throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
      }
      await start();
    } catch (error) { managed.close(); throw error; }
  };
  transport.close = async () => {
    // Remove the server before closing the attach client. An attach client's
    // exit is not a container exit witness, and a hanging SDK close cannot skip it.
    managed.close();
    await close();
  };
}

async function currentServerConfig(serverName: string): Promise<MCPServerConfig | undefined> {
  const loaded = await (await import('./config')).loadServerConfigs();
  if (!Array.isArray(loaded)) throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  return loaded.find(item => item.name === serverName);
}

/** Re-read policy/config at final tool dispatch; never treat stored approval as authority. */
export async function assertMcpIsolationDispatch(client: Client, serverName: string, config?: MCPServerConfig | null): Promise<void> {
  const managed = getManagedMcpIsolation(client.transport);
  if (!managed) {
    try {
      const current = config ?? (process.env.FLUJO_MCP_ISOLATION_FILE === undefined ? undefined
        : await currentServerConfig(serverName));
      if (current?.isolation !== undefined) throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
      if (current?.transport === 'stdio') assertHostMcpLaunchAllowed(current);
    } catch (error) {
      if (error instanceof McpIsolationError) throw error;
      throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    }
    return;
  }
  try {
    const current = config ?? await currentServerConfig(serverName);
    if (!current || current.disabled || current.transport !== 'stdio' || current.isolation === undefined
        || getCurrentWorkspace() !== managed.workspace || serverName !== managed.serverName
        || approvedIsolationDigest(current, managed.workspace) !== managed.policyDigest) {
      throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
    }
  } catch (error) {
    managed.close();
    if (error instanceof McpIsolationError) throw error;
    throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  }
}
