import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const mountSchema = z.object({
  name: identifier,
  source: z.string().max(256).regex(/^storage\/mcp-grants\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/)
    .refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..')),
}).strict();

/** Narrow v1: preinstalled immutable images, read-only granted paths, no egress. */
export const isolatedMcpPolicySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('docker-deny-egress'),
  image: z.string().regex(/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/),
  dockerExecutable: z.string().min(1).max(1024),
  daemon: z.string().max(1024).refine(value =>
    /^unix:\/\/\/[A-Za-z0-9_./-]+\.sock$/.test(value)
    || /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_-]+$/.test(value)),
  command: z.array(z.string().max(2048)).min(1).max(64)
    .refine(value => Boolean(value[0]?.length) && value.every(argument => !argument.includes('\0'))),
  environmentNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)
    .refine(value => !value.startsWith('DOCKER_') && !value.startsWith('FLUJO_'))).max(32),
  mounts: z.array(mountSchema).max(8),
  memoryMiB: z.number().int().min(64).max(1024),
  cpus: z.number().min(0.1).max(4).multipleOf(0.1),
  pidsLimit: z.number().int().min(16).max(256),
}).strict().superRefine((policy, context) => {
  if (new Set(policy.environmentNames).size !== policy.environmentNames.length
      || new Set(policy.mounts.map(mount => mount.name)).size !== policy.mounts.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate isolated grant' });
  }
});
export type IsolatedMcpPolicy = z.infer<typeof isolatedMcpPolicySchema>;

export class McpIsolationError extends Error {
  constructor(readonly code: 'ISOLATION_POLICY_INVALID' | 'ISOLATION_RECONSENT_REQUIRED' | 'ISOLATION_UNAVAILABLE') {
    super(code === 'ISOLATION_RECONSENT_REQUIRED' ? 'MCP isolation capabilities changed. Review and approve the new policy.'
      : code === 'ISOLATION_UNAVAILABLE' ? 'MCP isolation is unavailable. Check the local Linux Docker daemon and preinstalled image; host fallback is disabled.'
        : 'MCP isolation policy is invalid. Review the image, local daemon, grants and limits.');
    this.name = 'McpIsolationError';
  }
}

function parsedPolicy(value: unknown): IsolatedMcpPolicy {
  const result = isolatedMcpPolicySchema.safeParse(value);
  if (!result.success || !path.isAbsolute(result.data.dockerExecutable)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  return result.data;
}

/** Digest is an approval binding, not proof of owner authentication or a scanner verdict. */
export function isolatedMcpPolicyDigest(value: unknown): string {
  const policy = parsedPolicy(value);
  return createHash('sha256').update(JSON.stringify({
    ...policy, environmentNames: [...policy.environmentNames].sort(),
    mounts: [...policy.mounts].sort((a, b) => a.name.localeCompare(b.name, 'en')),
  })).digest('hex');
}

export interface IsolatedMcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly generation: string;
  readonly containerId: string;
  /** Absence is observed for the created container ID, never inferred from CLI exit. */
  close(): { outcome: 'removed' | 'absent' | 'unknown' };
}

type DockerEnvironment = Record<string, string> & { NODE_ENV: 'production' };

function hostEssentials(): DockerEnvironment {
  // Next's ambient ProcessEnv requires this field. Set it deliberately for the
  // CLI instead of inheriting the app's environment or widening the spawn type.
  if (process.platform !== 'win32') return { NODE_ENV: 'production' };
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return { NODE_ENV: 'production', SystemRoot: systemRoot, WINDIR: systemRoot };
}

function safeMount(workspaceRoot: string, relative: string): string {
  const root = path.resolve(workspaceRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  }
  const actual = fs.realpathSync(current);
  const inside = path.relative(fs.realpathSync(root), actual);
  if (!inside || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
      || /[,\r\n]/.test(actual)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  return actual;
}

/**
 * Materialize an approved OS-backed launch without inheriting host secrets or
 * allowing arbitrary Docker flags. No image pull, build, host command fallback,
 * remote daemon or pre-launch package script is performed.
 * The caller must authenticate the owner and recheck this digest at dispatch.
 */
export function createIsolatedMcpLaunch(value: unknown, approvedDigest: string,
  workspaceRoot: string, environment: Readonly<Record<string, string>> = {}): IsolatedMcpLaunch {
  const policy = parsedPolicy(value);
  if (approvedDigest !== isolatedMcpPolicyDigest(policy)) throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
  if (!path.isAbsolute(workspaceRoot)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  const env: DockerEnvironment = hostEssentials();
  for (const name of policy.environmentNames) {
    const provided = environment[name];
    if (typeof provided !== 'string' || provided.length > 16 * 1024 || provided.includes('\0')) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    if (name === 'NODE_ENV' && provided !== 'production') throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    env[name] = provided;
  }
  const generation = randomUUID();
  const name = `flujo-mcp-${generation}`;
  const tempRoot = path.resolve(os.tmpdir());
  const control = fs.mkdtempSync(path.join(tempRoot, 'flujo-mcp-isolation-'));
  function cleanupControl() {
    const relative = path.relative(tempRoot, control);
    if (!/^flujo-mcp-isolation-[A-Za-z0-9]+$/.test(relative)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    fs.rmSync(control, { recursive: true, force: true });
  }
  const globalArgs = ['--host', policy.daemon, '--config', control];
  function docker(args: string[]) {
    return execFileSync(policy.dockerExecutable, [...globalArgs, ...args], {
      env: hostEssentials(), windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
  }
  function ownedRows(filter: string): string[] {
    return docker(['container', 'ls', '--all', '--no-trunc', '--filter', filter,
      '--format', '{{.ID}} {{.Label "co.flujo.mcp-generation"}}']).split('\n').filter(Boolean);
  }
  function removeOwned(id: string): { outcome: 'removed' | 'absent' | 'unknown' } {
    try {
      const rows = ownedRows(`id=${id}`);
      if (rows.length === 0) { cleanupControl(); return { outcome: 'absent' }; }
      if (rows.length !== 1 || rows[0] !== `${id} ${generation}`) return { outcome: 'unknown' };
      docker(['container', 'rm', '--force', id]);
      if (ownedRows(`id=${id}`).length !== 0) return { outcome: 'unknown' };
      cleanupControl();
      return { outcome: 'removed' };
    } catch { return { outcome: 'unknown' }; }
  }
  let creationRequested = false;
  try {
    if (docker(['info', '--format', '{{.OSType}}']) !== 'linux') throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    const volumes = JSON.parse(docker(['image', 'inspect', policy.image, '--format', '{{json .Config.Volumes}}']));
    if (volumes !== null && (typeof volumes !== 'object' || Array.isArray(volumes) || Object.keys(volumes).length !== 0)) {
      throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    }
    const args = ['container', 'create', '--interactive', '--pull=never',
      '--name', name, '--label', `co.flujo.mcp-generation=${generation}`,
      '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--user=65534:65534', '--no-healthcheck', '--memory', `${policy.memoryMiB}m`,
      '--memory-swap', `${policy.memoryMiB}m`, '--cpus', String(policy.cpus),
      '--pids-limit', String(policy.pidsLimit), '--shm-size=1m',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'];
    for (const mount of policy.mounts) {
      args.push('--mount', `type=bind,source=${safeMount(workspaceRoot, mount.source)},target=/grants/${mount.name},readonly`);
    }
    for (const variable of policy.environmentNames) args.push('--env', variable);
    args.push(policy.image, ...policy.command);
    // Create without executing first. Starting by immutable ID prevents a late
    // `run` request from creating a server after transport cleanup observed none.
    creationRequested = true;
    const containerId = execFileSync(policy.dockerExecutable, [...globalArgs, ...args], {
      env, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)
      || ownedRows(`id=${containerId}`).join('\n') !== `${containerId} ${generation}`) {
      throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    }
    let completed: { outcome: 'removed' | 'absent' } | undefined;
    return Object.freeze({ command: policy.dockerExecutable,
      args: Object.freeze([...globalArgs, 'container', 'start', '--attach', '--interactive', containerId]),
      env: Object.freeze(hostEssentials()), cwd: control, generation, containerId,
      close: () => {
        if (completed) return completed;
        const result = removeOwned(containerId);
        if (result.outcome !== 'unknown') completed = { outcome: result.outcome };
        return result;
      },
    });
  } catch (error) {
    if (creationRequested) {
      // A timed out create may leave a stopped container. Reconcile only this
      // generation; retain the control directory when observation is uncertain.
      try {
        const rows = ownedRows(`name=^/${name}$`);
        if (rows.length === 1 && new RegExp(`^[a-f0-9]{64} ${generation}$`).test(rows[0])) removeOwned(rows[0].split(' ')[0]);
      } catch { /* Never delete an unobserved container or claim cleanup success. */ }
    } else cleanupControl();
    if (error instanceof McpIsolationError) throw error;
    throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  }
}
