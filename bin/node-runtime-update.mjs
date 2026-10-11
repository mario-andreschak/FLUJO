/** Opt-in app bootstrap; imports only Node built-ins before runtime admission. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isSupportedNodeRuntime, nodeRuntimeDiagnostic, nodeRuntimeManualSteps } from './node-runtime.mjs';

const officialRoot = 'https://nodejs.org/dist/';
export const managedNodeDirectory = () => path.join(os.homedir(), '.flujo', 'node-runtimes');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function nodeDistribution(platform = process.platform, arch = process.arch) {
  const osName = { win32: 'win', linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = platform === 'win32' && arch === 'ia32' ? 'x86' : arch;
  if (!osName || !['x64', 'arm64', ...(osName === 'win' ? ['x86'] : [])].includes(cpu)) {
    throw new Error('The automatic Node update is unavailable for this operating system or architecture.');
  }
  return { osName, cpu, extension: osName === 'win' ? 'zip' : 'tar.gz', binary: osName === 'win' ? 'node.exe' : 'bin/node' };
}

export function latestSupportedRelease(releases, major) {
  if (!Array.isArray(releases) || ![22, 24].includes(major)) throw new Error('Invalid Node release index.');
  const versions = releases.flatMap(item => {
    if (!item?.lts || typeof item.version !== 'string') return [];
    const match = /^v?(22|24)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/.exec(item.version);
    if (!match || Number(match[1]) !== major) return [];
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)
        || minor > 2147483647 || patch > 2147483647 || minor < (major === 22 ? 17 : 2)) return [];
    return [{ minor, patch }];
  });
  versions.sort((a, b) => b.minor - a.minor || b.patch - a.patch);
  if (!versions.length) throw new Error('No supported Node LTS release was found.');
  // Build filenames and executable paths from admitted numbers, never index text.
  return `${major}.${versions[0].minor}.${versions[0].patch}`;
}

async function download(url, maximumBytes) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('The official Node download could not be completed.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error('The official Node download exceeded its expected size.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout?.on('data', chunk => {
      output += chunk;
      if (output.length > 4096) { child.kill(); reject(new Error('The Node verification command returned unexpected output.')); }
    });
    // Installer/probe failures get bounded guidance, not arbitrary subprocess output.
    child.stderr?.resume();
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('The Node installation or verification command failed.')));
  });
}

export async function extractNodeArchive(archive, directory, platform) {
  if (platform === 'win32') {
    const source = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
      + '[IO.Compression.ZipFile]::ExtractToDirectory($env:FLUJO_NODE_ARCHIVE, $env:FLUJO_NODE_EXTRACT_ROOT)';
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { env: { ...process.env, FLUJO_NODE_ARCHIVE: archive, FLUJO_NODE_EXTRACT_ROOT: directory } });
  } else {
    await run('tar', ['-xzf', archive, '-C', directory]);
  }
}

export async function findManagedNode({ baseDirectory = managedNodeDirectory(), platform = process.platform, arch = process.arch } = {}) {
  try {
    const receiptBytes = await fs.readFile(path.join(baseDirectory, 'active.json'));
    if (receiptBytes.length > 2048) return null;
    const receipt = JSON.parse(receiptBytes);
    const distribution = nodeDistribution(platform, arch);
    if (!isSupportedNodeRuntime(receipt.version) || receipt.platform !== platform || receipt.arch !== arch
        || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null;
    const stem = `node-v${receipt.version}-${distribution.osName}-${distribution.cpu}-`;
    if (typeof receipt.directory !== 'string' || !receipt.directory.startsWith(stem)
        || !/^[a-f0-9]{32}$/.test(receipt.directory.slice(stem.length))) return null;
    const directory = path.join(baseDirectory, receipt.directory);
    const executable = path.join(directory, distribution.binary);
    if (hash(await fs.readFile(executable)) !== receipt.sha256) return null;
    return { executable, directory, version: receipt.version };
  } catch { return null; }
}

export async function installManagedNode({
  major = 22, baseDirectory = managedNodeDirectory(), platform = process.platform, arch = process.arch,
  fetchBytes = download, extract = extractNodeArchive, probe = run,
} = {}) {
  const distribution = nodeDistribution(platform, arch);
  const releases = JSON.parse((await fetchBytes(new URL('index.json', officialRoot), 2 * 1024 * 1024)).toString());
  const version = latestSupportedRelease(releases, major);
  const current = await findManagedNode({ baseDirectory, platform, arch });
  if (current?.version === version) return current;
  const stem = `node-v${version}-${distribution.osName}-${distribution.cpu}`;
  const filename = `${stem}.${distribution.extension}`;
  const checksumText = (await fetchBytes(new URL(`v${version}/SHASUMS256.txt`, officialRoot), 1024 * 1024)).toString();
  const checksums = checksumText.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s{2}(.+)$/.exec(line)).filter(Boolean);
  const matches = checksums.filter(match => match[2] === filename);
  if (matches.length !== 1) throw new Error('The official Node archive checksum is missing or ambiguous.');
  const archiveBytes = await fetchBytes(new URL(`v${version}/${filename}`, officialRoot), 200 * 1024 * 1024);
  if (hash(archiveBytes) !== matches[0][1]) throw new Error('The Node archive failed SHA-256 verification.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-node-update-'));
  const directoryName = `${stem}-${randomUUID().replaceAll('-', '')}`;
  const directory = path.join(baseDirectory, directoryName);
  let installed = false;
  let receiptTemporary;
  try {
    const archive = path.join(temporary, filename);
    const extraction = path.join(temporary, 'extract');
    // Intentional installer payload: fixed official HTTPS origin, no redirects,
    // bounded size, and matching official SHA-256 before any write or extraction.
    await fs.writeFile(archive, archiveBytes, { mode: 0o600 });
    await fs.mkdir(extraction);
    await extract(archive, extraction, platform);
    await fs.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
    await fs.cp(path.join(extraction, stem), directory, { recursive: true, errorOnExist: true, force: false });
    const executable = path.join(directory, distribution.binary);
    const actualVersion = await probe(executable, ['-p', 'process.versions.node']);
    if (actualVersion !== version || !isSupportedNodeRuntime(actualVersion)) throw new Error('The installed Node runtime failed verification.');
    const sha256 = hash(await fs.readFile(executable));
    receiptTemporary = path.join(baseDirectory, `active-${randomUUID()}.json`);
    await fs.writeFile(receiptTemporary, JSON.stringify({ version, platform, arch, directory: directoryName, sha256 }), { mode: 0o600 });
    await fs.rename(receiptTemporary, path.join(baseDirectory, 'active.json'));
    installed = true;
    return { executable, directory, version };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    if (receiptTemporary) await fs.rm(receiptTemporary, { force: true });
    if (!installed) await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function confirmNodeUpdate(major, { input = process.stdin, output = process.stderr } = {}) {
  const terminal = readline.createInterface({ input, output });
  return new Promise(resolve => {
    terminal.once('close', () => resolve(false));
    terminal.once('SIGINT', () => terminal.close());
    terminal.question(`Install the latest patched Node.js ${major}.x for FLUJO in your home directory and restart this command automatically? [y/N] `, answer => {
      resolve(/^(y|yes)$/i.test(answer.trim()));
      terminal.close();
    });
  });
}

export function relaunchWithNode(runtime, argv = process.argv.slice(1), env = process.env) {
  const childEnv = { ...env };
  // Windows environments are case-insensitive; emit one canonical PATH key.
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path');
  const oldPath = pathKey ? childEnv[pathKey] : '';
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path') delete childEnv[key];
  const binaryDirectory = path.dirname(runtime.executable);
  childEnv.PATH = binaryDirectory + path.delimiter + oldPath;
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, argv, { stdio: 'inherit', env: childEnv, windowsHide: true });
    const forward = signal => { try { child.kill(signal); } catch { /* Child already exited. */ } };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 1 : 0)); });
  });
}

export async function ensureSupportedAppRuntime({
  version = process.versions.node, argv = process.argv, interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  print = message => console.error(message), confirm = confirmNodeUpdate, find = findManagedNode,
  install = installManagedNode, relaunch = relaunchWithNode,
} = {}) {
  const explicitUpdate = argv.includes('--update-node');
  // Consume the bootstrap flag before Next or the packaged CLI parses its options.
  for (let index = argv.length - 1; index >= 2; index--) if (argv[index] === '--update-node') argv.splice(index, 1);
  if (isSupportedNodeRuntime(version)) return {};
  const managed = await find();
  if (managed && !explicitUpdate) {
    print(`[FLUJO] Using Node.js v${managed.version} previously installed for FLUJO.`);
    try { return { exitCode: await relaunch(managed, argv.slice(1)) }; }
    catch {
      print(`[FLUJO] The installed Node runtime could not restart FLUJO.\n\n${nodeRuntimeManualSteps()}`);
      return { exitCode: 1 };
    }
  }
  print(`[FLUJO] ${nodeRuntimeDiagnostic(version)}`);
  const major = Number(version?.replace(/^v/, '').split('.')[0]) === 22 ? 22 : 24;
  if (!explicitUpdate && (!interactive || !(await confirm(major)))) {
    print(`\n${nodeRuntimeManualSteps()}\n\nFor an automatic app update, retry with --update-node (for example: npm start -- --update-node or flujo --update-node).`);
    return { exitCode: 1 };
  }
  try {
    print(`[FLUJO] Downloading and verifying the latest supported Node.js ${major}.x from nodejs.org...`);
    const runtime = await install({ major });
    print(`[FLUJO] Installed Node.js v${runtime.version} for FLUJO. Restarting your command...`);
    return { exitCode: await relaunch(runtime, argv.slice(1)) };
  } catch {
    print(`[FLUJO] The automatic Node update or restart could not be completed.\n\n${nodeRuntimeManualSteps()}`);
    return { exitCode: 1 };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await ensureSupportedAppRuntime({ argv: [process.execPath, ...process.argv.slice(2)] });
  process.exitCode = result.exitCode ?? 0;
}
