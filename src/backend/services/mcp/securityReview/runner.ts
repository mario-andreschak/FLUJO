import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const VERSION = '2.12.0';
const REVISION = 'c7958a3268d9498644b22edb75d0f051bbc8cbfc';
const WHEEL = '62973f6254d30c871480246869f88a01e17dff6f12e9d43010962eb0d7e305f4';
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class ScannerUnavailableError extends Error {
  constructor(message = 'SkillSpector is unavailable. Configure the optional scanner using the MCP security review guide.') {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

// Credentials used by FLUJO/model providers never enter this child environment.
// Docker transport configuration belongs to the operator, not the candidate.
function dockerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

async function docker(args: string[], signal?: AbortSignal, input?: Buffer, timeout = 10_000) {
  signal?.throwIfAborted();
  return new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true,
      env: dockerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new ScannerUnavailableError('Source review cancelled.'));
    const timer = setTimeout(() => stop(new ScannerUnavailableError('SkillSpector exceeded its time limit.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    // Handle an abort between the preflight check and listener registration.
    if (signal?.aborted) abort();
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > OUTPUT_LIMIT) stop(new ScannerUnavailableError('SkillSpector output exceeded the review limit.'));
      else chunks.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > OUTPUT_LIMIT) stop(new ScannerUnavailableError('SkillSpector output exceeded the review limit.'));
    });
    child.stdin.on('error', () => { /* early CLI exit is reported by close */ });
    child.on('error', () => { failure ??= new ScannerUnavailableError(); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? 2 });
    });
    child.stdin.end(input);
  });
}

function tarEntry(filename: string, content: Buffer, directory = false): Buffer {
  const header = Buffer.alloc(512);
  const split = filename.lastIndexOf('/');
  const name = Buffer.byteLength(filename) <= 100 ? filename : filename.slice(split + 1);
  const prefix = Buffer.byteLength(filename) <= 100 ? '' : filename.slice(0, split);
  if (!name || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new ScannerUnavailableError('A source path exceeds the archive limit.');
  }
  const octal = (offset: number, length: number, value: number) =>
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  header.write(name, 0, 100, 'utf8');
  octal(100, 8, directory ? 0o555 : 0o444);
  octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, content.length); octal(136, 12, 0);
  header.fill(32, 148, 156); header.write(directory ? '5' : '0', 156, 1);
  header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

/** Plain files only. No host mount, archive extraction hooks, or candidate execution. */
export function scannerSourceArchive(files: Array<{ path: string; content: Buffer }>): Buffer {
  if (files.length < 1 || files.length > 256) throw new ScannerUnavailableError('Source file limit exceeded.');
  const directories = new Set<string>();
  const directoryAliases = new Map<string, string>();
  const names = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!file.path || file.path.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || names.has(file.path.toLowerCase()) || file.content.length > 1024 * 1024) {
      throw new ScannerUnavailableError('Unsupported source archive entry.');
    }
    names.add(file.path.toLowerCase());
    bytes += file.content.length;
    if (bytes > 8 * 1024 * 1024) throw new ScannerUnavailableError('Source byte limit exceeded.');
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const directory = parts.slice(0, i).join('/');
      const previous = directoryAliases.get(directory.toLowerCase());
      if (previous && previous !== directory) throw new ScannerUnavailableError('Conflicting source directories.');
      directoryAliases.set(directory.toLowerCase(), directory);
      directories.add(directory);
    }
  }
  if ([...directories].some(directory => names.has(directory.toLowerCase()))) {
    throw new ScannerUnavailableError('Conflicting source archive entries.');
  }
  return Buffer.concat([
    ...[...directories].sort().map(name => tarEntry(name, Buffer.alloc(0), true)),
    ...files.map(file => tarEntry(file.path, file.content)), Buffer.alloc(1024),
  ]);
}

async function inspectOwned(name: string, owner: string, imageId: string) {
  const result = await docker(['container', 'inspect', name]);
  if (result.exitCode !== 0) throw new ScannerUnavailableError('Scanner cleanup could not verify container ownership.');
  const records = JSON.parse(result.stdout) as Array<{ Id?: string; Image?: string; Config?: { Labels?: Record<string, string> } }>;
  const record = records[0];
  if (records.length !== 1 || !/^[0-9a-f]{64}$/.test(record?.Id ?? '')
    || record.Image !== imageId || record.Config?.Labels?.['org.flujo.security-review.owner'] !== owner) {
    throw new ScannerUnavailableError('Scanner container ownership did not match.');
  }
  return record.Id!;
}

/** Operator-provisioned immutable engine. Never install or pull software during review. */
export async function runSkillSpector(files: Array<{ path: string; content: Buffer }>, signal: AbortSignal) {
  const imageId = process.env.FLUJO_SKILLSPECTOR_IMAGE ?? '';
  if (!IMAGE_PATTERN.test(imageId)) throw new ScannerUnavailableError();
  const archive = scannerSourceArchive(files);
  const inspection = await docker(['image', 'inspect', imageId], signal);
  if (inspection.exitCode !== 0) throw new ScannerUnavailableError();
  const images = JSON.parse(inspection.stdout) as Array<{
    Id: string; Os: string; Config: { Labels?: Record<string, string>; Volumes?: unknown; Entrypoint?: string[]; User?: string };
  }>;
  const image = images[0];
  if (images.length !== 1 || image?.Id !== imageId || image.Os !== 'linux'
    || image.Config.Labels?.['org.flujo.skillspector.version'] !== VERSION
    || image.Config.Labels?.['org.flujo.skillspector.revision'] !== REVISION
    || image.Config.Labels?.['org.flujo.skillspector.wheel-sha256'] !== WHEEL
    || image.Config.User !== '1000:1000' || image.Config.Volumes
    || JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(['/opt/scanner/.venv/bin/skillspector'])) {
    throw new ScannerUnavailableError('The configured scanner image does not match the pinned engine.');
  }
  const owner = randomUUID();
  const name = `flujo-security-review-${owner}`;
  const seedName = `${name}-seed`;
  const volume = `${name}-source`;
  let volumeAttempted = false;
  let seedAttempted = false;
  let createAttempted = false;
  let container: string | undefined;
  try {
    signal.throwIfAborted();
    volumeAttempted = true;
    const storage = await docker(['volume', 'create', '--label', `org.flujo.security-review.owner=${owner}`, volume], signal);
    if (storage.exitCode !== 0 || storage.stdout.trim() !== volume) throw new ScannerUnavailableError('Source staging failed.');
    seedAttempted = true;
    const seed = await docker(['create', '--pull=never', '--name', seedName,
      '--label', `org.flujo.security-review.owner=${owner}`, '--network', 'none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '1000:1000',
      '--mount', `type=volume,src=${volume},dst=/input,volume-nocopy`,
      '--entrypoint', '/usr/local/bin/python', imageId, '-c', 'pass'], signal);
    if (seed.exitCode !== 0) throw new ScannerUnavailableError('Source staging failed.');
    const seedId = await inspectOwned(seedName, owner, imageId);
    const copied = await docker(['cp', '-a', '-', `${seedId}:/input`], signal, archive);
    if (copied.exitCode !== 0) throw new ScannerUnavailableError('Source staging failed.');
    createAttempted = true;
    const created = await docker(['create', '--pull=never', '--name', name,
      '--label', `org.flujo.security-review.owner=${owner}`, '--init', '--network', 'none',
      '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--cpus=1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
      '--mount', `type=volume,src=${volume},dst=/input,readonly,volume-nocopy`,
      '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'PYTHONIOENCODING=utf-8',
      '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'LANGSMITH_TRACING=false',
      '--env', 'SKILLSPECTOR_MAX_WORKFLOW_SECONDS=75', '--env', 'SKILLSPECTOR_OSV_TIMEOUT=2',
      imageId, 'scan', '/input', '--no-llm', '--format', 'json', '--fail-on-incomplete'], signal);
    if (created.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(created.stdout.trim())) throw new ScannerUnavailableError();
    container = await inspectOwned(name, owner, imageId);
    const started = await docker(['start', '--attach', container], signal, undefined, 90_000);
    const state = await docker(['inspect', '--format', '{{json .State}}', container], signal);
    if (state.exitCode !== 0) throw new ScannerUnavailableError();
    const terminal = JSON.parse(state.stdout) as { Running?: boolean; OOMKilled?: boolean; ExitCode?: number };
    if (terminal.Running || terminal.OOMKilled || ![0, 1].includes(terminal.ExitCode ?? 2)) {
      throw new ScannerUnavailableError('SkillSpector could not complete this review.');
    }
    return { stdout: started.stdout, exitCode: terminal.ExitCode!, imageId };
  } finally {
    let cleanupFailure: unknown;
    const attempt = async (action: () => Promise<void>) => {
      try { await action(); } catch (error) { cleanupFailure ??= error; }
    };
    if (createAttempted) await attempt(async () => {
      // A lost create response may still have created the named container. Lookup
      // is bounded and verifies our fresh ownership label and immutable image.
      if (!container) {
        const lookup = await docker(['ps', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
        if (lookup.exitCode !== 0) throw new ScannerUnavailableError('Scanner cleanup failed.');
        if (lookup.stdout.trim()) container = await inspectOwned(name, owner, imageId);
      }
      if (container) {
        const verified = await inspectOwned(container, owner, imageId);
        const removed = await docker(['rm', '--force', verified]);
        if (removed.exitCode !== 0) throw new ScannerUnavailableError('Scanner cleanup failed.');
      }
    });
    if (seedAttempted) await attempt(async () => {
      const lookup = await docker(['ps', '--all', '--no-trunc', '--filter', `name=^/${seedName}$`, '--format', '{{.ID}}']);
      if (lookup.exitCode !== 0) throw new ScannerUnavailableError('Source cleanup failed.');
      if (lookup.stdout.trim()) {
        const verified = await inspectOwned(seedName, owner, imageId);
        const removed = await docker(['rm', '--force', verified]);
        if (removed.exitCode !== 0) throw new ScannerUnavailableError('Source cleanup failed.');
      }
    });
    if (volumeAttempted) await attempt(async () => {
      const lookup = await docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']);
      if (lookup.exitCode !== 0) throw new ScannerUnavailableError('Source cleanup failed.');
      if (lookup.stdout.trim()) {
        const checked = await docker(['volume', 'inspect', volume]);
        if (checked.exitCode !== 0) throw new ScannerUnavailableError('Source cleanup failed.');
        const records = JSON.parse(checked.stdout) as Array<{ Name?: string; Labels?: Record<string, string> }>;
        if (records.length !== 1 || records[0].Name !== volume
          || records[0].Labels?.['org.flujo.security-review.owner'] !== owner) {
          throw new ScannerUnavailableError('Source ownership did not match.');
        }
        const removed = await docker(['volume', 'rm', volume]);
        if (removed.exitCode !== 0) throw new ScannerUnavailableError('Source cleanup failed.');
      }
    });
    if (cleanupFailure) throw cleanupFailure;
  }
}
