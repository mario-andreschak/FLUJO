import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { realpath } from '../../../utils/realpath';
import { windowsPrivateAuthorityStampAsync } from './windowsPrivateAuthority';
import { assertIsolatedMcpContainerInspection, assertIsolatedMcpDaemonInfo } from './isolatedMcpInspection';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
/**
 * The policy names the host program FLUJO runs, so only an absolute path to a
 * Docker command line program is accepted. Any other program, even one the
 * owner approved by mistake, never runs with the Docker arguments below.
 */
export function isDockerCliPath(value: string): boolean {
  return path.isAbsolute(value) && !/[\0\r\n]/.test(value)
    && /^docker(?:\.exe)?$/i.test(path.basename(value));
}
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
  dockerExecutable: z.string().min(1).max(1024).refine(isDockerCliPath),
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
      : code === 'ISOLATION_UNAVAILABLE' ? 'MCP isolation is unavailable. Check the local Linux Docker daemon, supported resource limits, preinstalled image and private grant files; host fallback is disabled.'
        : 'MCP isolation policy is invalid. Review the Docker program path, image, local daemon, mounts, single-line environment grants and limits.');
    this.name = 'McpIsolationError';
  }
}

function parsedPolicy(value: unknown): IsolatedMcpPolicy {
  const result = isolatedMcpPolicySchema.safeParse(value);
  if (!result.success || !isDockerCliPath(result.data.dockerExecutable)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
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
  readonly ownershipKey?: string;
  /**
   * Absence is observed for the created container ID, never inferred from CLI exit.
   * Callers that arrive while a removal runs share it; once removal is observed,
   * every later call returns that outcome without contacting Docker again.
   */
  close(): Promise<{ outcome: 'removed' | 'absent' | 'unknown' }>;
}

type DockerEnvironment = Record<string, string> & { NODE_ENV: 'production' };

/** Names the private control folder, so a restart after a crash can find and remove it. */
const CONTROL_LABEL = 'co.flujo.mcp-control';
const CONTROL_FOLDER = /^flujo-mcp-isolation-[A-Za-z0-9]+$/;

function hostEssentials(): DockerEnvironment {
  // Next's ambient ProcessEnv requires this field. Set it deliberately for the
  // CLI instead of inheriting the app's environment or widening the spawn type.
  if (process.platform !== 'win32') return { NODE_ENV: 'production' };
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return { NODE_ENV: 'production', SystemRoot: systemRoot, WINDIR: systemRoot };
}

async function safeMount(workspaceRoot: string, relative: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  }
  const actual = await realpath(current);
  const inside = path.relative(await realpath(root), actual);
  if (!inside || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
      || /[,\r\n]/.test(actual)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  return actual;
}

/** Container grants must never become loader/runtime options for the host CLI. */
async function privateEnvironmentFile(control: string, environment: ReadonlyMap<string, string>) {
  const filename = path.join(control, 'container.env');
  const handle = await fs.promises.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  const identity = await handle.stat({ bigint: true }).catch(async (error: unknown) => { await handle.close(); throw error; });
  let content: Buffer | undefined;
  async function assertOwned() {
    const held = await handle.stat({ bigint: true });
    const named = await fs.promises.lstat(filename, { bigint: true });
    if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || held.nlink !== BigInt(1)
        || held.dev !== identity.dev || held.ino !== identity.ino || named.dev !== held.dev || named.ino !== held.ino
        || held.uid !== identity.uid || held.gid !== identity.gid || held.mode !== identity.mode) {
      throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    }
  }
  async function dispose() {
    content?.fill(0);
    try { await assertOwned(); await fs.promises.unlink(filename); }
    finally { await handle.close(); }
  }
  try {
    await assertOwned();
    // Validate the empty file first: a Windows mode bit alone cannot protect a
    // secret, and a failed ACL check must never leave secret bytes on disk.
    if (process.platform === 'win32') await windowsPrivateAuthorityStampAsync(filename);
    else if (identity.uid !== BigInt(process.getuid!()) || (identity.mode & BigInt(0o077)) !== BigInt(0)) {
      throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    }
    await assertOwned();
    content = Buffer.from([...environment].map(([name, value]) => `${name}=${value}\n`).join(''));
    await handle.writeFile(content);
    await assertOwned();
    return { filename, dispose };
  } catch (error) { await dispose(); throw error; }
}

/**
 * Materialize an approved OS-backed launch without inheriting host secrets or
 * allowing arbitrary Docker flags. No image pull, build, host command fallback,
 * remote daemon or pre-launch package script is performed.
 * The caller must authenticate the owner and recheck this digest at dispatch.
 */
export async function createIsolatedMcpLaunch(value: unknown, approvedDigest: string,
  workspaceRoot: string, environment: Readonly<Record<string, string>> = {},
  ownership?: { key: string }): Promise<IsolatedMcpLaunch> {
  const policy = parsedPolicy(value);
  if (approvedDigest !== isolatedMcpPolicyDigest(policy)) throw new McpIsolationError('ISOLATION_RECONSENT_REQUIRED');
  if (!path.isAbsolute(workspaceRoot)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  if (ownership && !/^[a-f0-9]{64}$/.test(ownership.key)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
  // A Map keeps granted names out of object property lookups entirely.
  const containerEnvironment = new Map<string, string>();
  for (const name of policy.environmentNames) {
    const provided = Object.hasOwn(environment, name) ? environment[name] : undefined;
    if (typeof provided !== 'string' || provided.length > 16 * 1024 || /[\0\r\n]/.test(provided)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    if (name === 'NODE_ENV' && provided !== 'production') throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    containerEnvironment.set(name, provided);
  }
  const generation = randomUUID();
  // Docker's atomic name uniqueness also fences other processes and restarts.
  // A predecessor cannot be bypassed by allocating a fresh random generation.
  const name = `flujo-mcp-${ownership?.key ?? generation}`;
  // Windows Temp can inherit outsider read access. Use the private profile
  // anchor and still require native ACL admission before writing any grants.
  const tempParent = process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir();
  if (!tempParent || !path.isAbsolute(tempParent)) throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  const tempRoot = path.resolve(tempParent);
  const control = await fs.promises.mkdtemp(path.join(tempRoot, 'flujo-mcp-isolation-'));
  async function cleanupControl() {
    const relative = path.relative(tempRoot, control);
    if (!CONTROL_FOLDER.test(relative)) throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    await fs.promises.rm(control, { recursive: true, force: true });
  }
  const globalArgs = ['--host', policy.daemon, '--config', control];
  function docker(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(policy.dockerExecutable, [...globalArgs, ...args], {
        env: hostEssentials(), windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8',
      }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
      // Docker reads no input here; closing it at once matches an ignored stdin.
      child.stdin?.end();
    });
  }
  async function ownedRows(filter: string): Promise<string[]> {
    return (await docker(['container', 'ls', '--all', '--no-trunc', '--filter', filter,
      '--format', '{{.ID}} {{.Label "co.flujo.mcp-generation"}}'])).split('\n').filter(Boolean);
  }
  async function removeOwned(id: string): Promise<{ outcome: 'removed' | 'absent' | 'unknown' }> {
    try {
      const rows = await ownedRows(`id=${id}`);
      if (rows.length === 0) { await cleanupControl(); return { outcome: 'absent' }; }
      if (rows.length !== 1 || rows[0] !== `${id} ${generation}`) return { outcome: 'unknown' };
      await docker(['container', 'rm', '--force', id]);
      if ((await ownedRows(`id=${id}`)).length !== 0) return { outcome: 'unknown' };
      await cleanupControl();
      return { outcome: 'removed' };
    } catch { return { outcome: 'unknown' }; }
  }
  /**
   * A FLUJO process that crashed could not remove its sandbox, and the stopped
   * container still holds this server's name. Remove it and its control folder
   * so the next start can launch. Without --force Docker refuses to remove a
   * running container, so one that a live owner still runs is left alone.
   */
  async function removeCrashLeftovers(key: string): Promise<void> {
    try {
      const rows = (await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`,
        '--filter', `label=co.flujo.mcp-ownership=${key}`,
        '--filter', 'status=created', '--filter', 'status=exited', '--filter', 'status=dead',
        '--format', `{{.ID}} {{.Label "${CONTROL_LABEL}"}}`])).split('\n').filter(Boolean);
      for (const row of rows) {
        const [id, folder = ''] = row.split(' ');
        if (!/^[a-f0-9]{64}$/.test(id)) continue;
        await docker(['container', 'rm', id]);
        if ((await ownedRows(`id=${id}`)).length !== 0) continue;
        const leftover = path.join(tempRoot, folder);
        if (!CONTROL_FOLDER.test(folder) || leftover === control) continue;
        const stat = await fs.promises.lstat(leftover).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.promises.rm(leftover, { recursive: true, force: true });
      }
    } catch { /* The name stays taken and creation reports the sandbox unavailable. */ }
  }
  let creationRequested = false;
  try {
    assertIsolatedMcpDaemonInfo(JSON.parse(await docker(['info', '--format', '{{json .}}'])));
    const image = JSON.parse(await docker(['image', 'inspect', policy.image, '--format',
      '{"Id":{{json .Id}},"Config":{"Volumes":{{json (index .Config "Volumes")}}}}']));
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    const volumes: unknown = image.Config?.Volumes;
    if (volumes !== null && (typeof volumes !== 'object' || Array.isArray(volumes) || Object.keys(volumes).length !== 0)) {
      throw new McpIsolationError('ISOLATION_POLICY_INVALID');
    }
    // Keep the managed MCP server out of PID 1: Docker's init adopts and reaps
    // exited grandchildren while the server continues serving tool requests.
    // Mandatory lifecycle plumbing, never a configurable isolation capability.
    const args = ['container', 'create', '--interactive', '--init', '--pull=never',
      '--name', name, '--label', `co.flujo.mcp-generation=${generation}`,
      '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--cgroupns=private', '--ipc=private',
      '--user=65534:65534', '--no-healthcheck', '--memory', `${policy.memoryMiB}m`,
      '--log-driver=none',
      '--memory-swap', `${policy.memoryMiB}m`, '--cpus', String(policy.cpus),
      '--pids-limit', String(policy.pidsLimit), '--shm-size=1m',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'];
    if (ownership) {
      args.push('--label', `co.flujo.mcp-ownership=${ownership.key}`, '--label', `${CONTROL_LABEL}=${path.basename(control)}`);
      await removeCrashLeftovers(ownership.key);
    }
    const mounts: Array<{ source: string; target: string }> = [];
    for (const mount of policy.mounts) mounts.push({ source: await safeMount(workspaceRoot, mount.source), target: `/grants/${mount.name}` });
    for (const mount of mounts) {
      args.push('--mount', `type=bind,source=${mount.source},target=${mount.target},readonly,bind-recursive=disabled`);
    }
    const grants = policy.environmentNames.length ? await privateEnvironmentFile(control, containerEnvironment) : undefined;
    if (grants) args.push('--env-file', grants.filename);
    args.push(image.Id, ...policy.command);
    // Create without executing first. Starting by immutable ID prevents a late
    // `run` request from creating a server after transport cleanup observed none.
    let containerId: string;
    try {
      creationRequested = true;
      containerId = await docker(args);
    } finally { await grants?.dispose(); }
    if (!/^[a-f0-9]{64}$/.test(containerId)
      || (await ownedRows(`id=${containerId}`)).join('\n') !== `${containerId} ${generation}`) {
      throw new McpIsolationError('ISOLATION_UNAVAILABLE');
    }
    // Do not read Config.Env back into CLI output: it contains granted secrets.
    const inspectionFormat = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
      + '"State":{{json .State}},"RestartCount":{{json .RestartCount}},"HostConfig":{{json .HostConfig}},'
      + '"Mounts":{{json .Mounts}},"NetworkSettings":{{json .NetworkSettings}},"Config":{'
      + '"Image":{{json .Config.Image}},"User":{{json .Config.User}},"Cmd":{{json .Config.Cmd}},'
      + '"Labels":{{json .Config.Labels}},"Volumes":{{json .Config.Volumes}},"Healthcheck":{{json .Config.Healthcheck}}}}';
    assertIsolatedMcpContainerInspection(JSON.parse(await docker(['container', 'inspect', containerId, '--format', inspectionFormat])), {
      containerId, generation, name, imageId: image.Id, policy, mounts, ownershipKey: ownership?.key,
    });
    let completed: { outcome: 'removed' | 'absent' } | undefined;
    let removing: Promise<{ outcome: 'removed' | 'absent' | 'unknown' }> | undefined;
    return Object.freeze({ command: policy.dockerExecutable,
      args: Object.freeze([...globalArgs, 'container', 'start', '--attach', '--interactive', containerId]),
      env: Object.freeze(hostEssentials()), cwd: control, generation, containerId,
      ...(ownership ? { ownershipKey: ownership.key } : {}),
      close: () => {
        if (completed) return Promise.resolve(completed);
        removing ??= removeOwned(containerId).then(result => {
          if (result.outcome !== 'unknown') completed = { outcome: result.outcome };
          return result;
        }).finally(() => { removing = undefined; });
        return removing;
      },
    });
  } catch (error) {
    if (creationRequested) {
      // A timed out create may leave a stopped container. Reconcile only this
      // generation; retain the control directory when observation is uncertain.
      try {
        const rows = await ownedRows(`name=^/${name}$`);
        if (rows.length === 1 && new RegExp(`^[a-f0-9]{64} ${generation}$`).test(rows[0])) await removeOwned(rows[0].split(' ')[0]);
        // Another container holds the name, so this create made none and nothing uses the control folder.
        else if (rows.length === 1 && /^[a-f0-9]{64} \S+$/.test(rows[0]) && !rows[0].endsWith(` ${generation}`)) await cleanupControl();
      } catch { /* Never delete an unobserved container or claim cleanup success. */ }
    } else await cleanupControl();
    if (error instanceof McpIsolationError) throw error;
    throw new McpIsolationError('ISOLATION_UNAVAILABLE');
  }
}
