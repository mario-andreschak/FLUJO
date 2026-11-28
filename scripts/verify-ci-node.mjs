import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSupportedNodeRuntime } from '../bin/node-runtime.mjs';

export const CI_NODE_PROFILES = Object.freeze({
  historicalBuild: '22.13.1', minimum22: '22.23.4', current22: '22.23.4',
  minimum24: '24.22.1', current24: '24.22.1',
});
const manifestPath = new URL('./ci-node-binaries.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/**
 * The Node versions FLUJO ships (#1408): the private runtime the installers
 * set up and the container base. Each is an exact supported CI profile with
 * signed evidence. A container that stays on another Node line than the
 * installers must say why in `containerBehind`, and that note must go as soon
 * as both ship the same line, so the two cannot drift apart unnoticed.
 */
export function shippedNodeRuntimes(binaries = manifest) {
  const shipped = binaries.shipped ?? {};
  const supported = new Set(Object.entries(CI_NODE_PROFILES)
    .filter(([name]) => name !== 'historicalBuild').map(([, version]) => version));
  for (const kind of ['installer', 'container']) {
    if (!supported.has(shipped[kind])) throw new Error(`The shipped ${kind} Node must be an exact supported CI profile.`);
  }
  const sameLine = shipped.installer.split('.')[0] === shipped.container.split('.')[0];
  const behind = typeof shipped.containerBehind === 'string' && shipped.containerBehind.trim() !== '';
  if (!sameLine && !behind) {
    throw new Error('The container ships another Node line than the installers: move the container base, or say why in "containerBehind".');
  }
  if (sameLine && shipped.containerBehind !== undefined) {
    throw new Error('Remove "containerBehind": the container and the installers ship the same Node line.');
  }
  if (!binaries.containerBase?.reference?.includes(`/node:${shipped.container}-bookworm-slim@sha256:`)) {
    throw new Error('The pinned container base must be the shipped container Node.');
  }
  return { installer: shipped.installer, container: shipped.container };
}

/**
 * Every installer path sets up the shipped installer Node line: the Windows
 * private runtime (exact version; returns its archive checksums for the signed
 * evidence check), NodeSource, Homebrew, zypper and pacman on Linux and macOS,
 * and the CI checks that look for the Windows runtime folder.
 */
export function assertShippedInstallerSources({ installPs1, installSh, installerWorkflow, windowsInstallCheck }, binaries = manifest) {
  const { installer } = shippedNodeRuntimes(binaries);
  const major = installer.split('.')[0];
  const windows = [
    /\$folder = "node-v(\d+\.\d+\.\d+)-win-\$arch"/.exec(installPs1)?.[1],
    /Url = "https:\/\/nodejs\.org\/dist\/v(\d+\.\d+\.\d+)\/\$folder\.zip"/.exec(installPs1)?.[1],
    /Downloading verified Node\.js (\d+\.\d+\.\d+) /.exec(installPs1)?.[1],
  ];
  const hashes = {
    x64: /^\s*x64 = '([a-f0-9]{64})'\r?$/m.exec(installPs1)?.[1],
    arm64: /^\s*arm64 = '([a-f0-9]{64})'\r?$/m.exec(installPs1)?.[1],
  };
  if (windows.some((version) => version !== installer) || !hashes.x64 || !hashes.arm64) {
    throw new Error(`The Windows installer must download the shipped Node ${installer} with pinned checksums.`);
  }
  const nodesource = [...installSh.matchAll(/nodesource\.com\/setup_(\d+)\.x/g)].map((match) => match[1]);
  const brew = [...installSh.matchAll(/node@(\d+)/g)].map((match) => match[1]);
  const zypper = /zypper\) pm_install nodejs(\d+) /.exec(installSh)?.[1];
  const pacman = /pacman\) pm_install nodejs-lts-([a-z]+) /.exec(installSh)?.[1];
  if (nodesource.length !== 2 || brew.length === 0 || [...nodesource, ...brew, zypper].some((value) => value !== major)
      || pacman !== binaries.runtimes?.[installer]?.lts?.toLowerCase()) {
    throw new Error(`The Unix installer must install the shipped Node ${major} line on every package manager.`);
  }
  for (const [name, source] of [['installer workflow', installerWorkflow], ['Windows install check', windowsInstallCheck]]) {
    const folders = [...source.matchAll(/node-v(\d+\.\d+\.\d+)-win-x64/g)].map((match) => match[1]);
    if (!folders.length || folders.some((version) => version !== installer)) {
      throw new Error(`The ${name} must expect the shipped Node ${installer} runtime.`);
    }
  }
  return hashes;
}

export function assertCiContainerContract(source) {
  source = source.replaceAll('\r\n', '\n');
  const stages = source.split(/^FROM /m).slice(1);
  if (stages.length !== 2 || !stages[0].startsWith(`${manifest.containerBase.reference} AS builder\n`)
      || !stages[1].startsWith(`${manifest.containerBase.reference} AS runtime\n`)) {
    throw new Error('Both container stages must use the exact observed current patched Node base digest.');
  }
  const command = `RUN node scripts/verify-ci-node.mjs ${shippedNodeRuntimes().container} --binary-only\n`;
  for (const stage of stages) {
    if (stage.split(command).length !== 2) throw new Error('Each container stage must verify its official Node binary.');
  }
  if (stages[0].indexOf('COPY . .\n') < 0 || stages[0].indexOf('COPY . .\n') > stages[0].indexOf(command)
      || stages[0].indexOf(command) > stages[0].indexOf('ARG FLUJO_EXECUTION_ADAPTER_MODULE=')) {
    throw new Error('Builder Node identity must be verified after copying source and before application build.');
  }
  const bin = stages[1].indexOf('COPY --from=builder /app/bin ./bin\n');
  const verifier = stages[1].indexOf('COPY --from=builder /app/scripts/verify-ci-node.mjs /app/scripts/ci-node-binaries.json ./scripts/\n');
  if (bin < 0 || verifier < 0 || Math.max(bin, verifier) > stages[1].indexOf(command)) {
    throw new Error('The runtime image must ship the canonical guard and binary verifier before measurement.');
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const OFFICIAL_DIST = 'https://nodejs.org/dist';

/** Read one official release file; brief network failures are retried. */
async function officialDownload(url, limit) {
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Official Node download failed with status ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > limit) throw new Error('Official Node download exceeded its size limit.');
      return bytes;
    } catch (error) {
      failure = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw failure;
}

/** The regular file at exactly `member` inside a gzipped tar archive. */
export function archiveMember(archive, member) {
  const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Official Node archive is malformed.');
    const size = parseInt(sizeText, 8);
    const start = offset + 512;
    if (start + size > tar.length) throw new Error('Official Node archive is malformed.');
    if (name === member && (header[156] === 0 || header[156] === 0x30)) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Official Node archive lacks its executable.');
}

/**
 * macOS has no recorded executable digest. Follow the checksum file whose
 * signature was verified when it was pinned to the official archive, and
 * return the digest of the executable inside it.
 */
async function darwinExecutableDigest({ expectedVersion, arch, selected, download }) {
  const sums = await download(`${OFFICIAL_DIST}/v${expectedVersion}/SHASUMS256.txt`, 1024 * 1024);
  if (sha256(sums) !== selected.signedChecksumsSha256) throw new Error('Official Node checksums differ from the signed release record.');
  const name = `node-v${expectedVersion}-darwin-${arch}`;
  const listed = sums.toString('utf8').split('\n').map((line) => /^([a-f0-9]{64}) {2}(\S+)$/.exec(line.trim()))
    .find((match) => match?.[2] === `${name}.tar.gz`)?.[1];
  if (!listed) throw new Error('The signed Node checksums do not list the macOS archive.');
  const archive = await download(`${OFFICIAL_DIST}/v${expectedVersion}/${name}.tar.gz`, 256 * 1024 * 1024);
  if (sha256(archive) !== listed) throw new Error('The official Node macOS archive differs from the signed checksums.');
  return { digest: sha256(archiveMember(archive, `${name}/bin/node`)), archive: `${name}.tar.gz` };
}

/** Measures official executable bytes before dependency, build or publication commands. */
export async function verifyCiNode({ expectedVersion, historicalBuild = false,
  version = process.versions.node, uv = process.versions.uv,
  platform = process.platform, arch = process.arch, executable = process.execPath,
  binaries = manifest, nodeOptions = process.env.NODE_OPTIONS ?? '', execArgv = process.execArgv,
  download = officialDownload } = {}) {
  if (!Object.values(CI_NODE_PROFILES).includes(expectedVersion) || version !== expectedVersion) {
    throw new Error('CI Node version differs from the exact selected runtime.');
  }
  if (historicalBuild && expectedVersion !== CI_NODE_PROFILES.historicalBuild) {
    throw new Error('Historical build evidence is restricted to Node 22.13.1.');
  }
  if (!historicalBuild) assertSupportedNodeRuntime(version);
  if (nodeOptions || execArgv.length) throw new Error('CI runtime verification requires ordinary Node options and default heap.');
  const darwin = platform === 'darwin' && ['arm64', 'x64'].includes(arch);
  if (!darwin && (arch !== 'x64' || !['linux', 'win32'].includes(platform))) throw new Error('CI runtime binary has an unsupported platform.');
  const selected = binaries.runtimes?.[expectedVersion];
  const recorded = darwin ? selected?.signedChecksumsSha256 : selected?.executables?.[platform];
  if (binaries.schemaVersion !== 1 || selected?.uv !== uv || !/^[a-f0-9]{64}$/.test(recorded ?? '')) {
    throw new Error('CI runtime has missing or mismatched official binary/libuv evidence.');
  }
  const official = darwin ? await darwinExecutableDigest({ expectedVersion, arch, selected, download }) : undefined;
  const actual = await hashFile(realpathSync.native(executable));
  if (actual !== (official?.digest ?? recorded)) throw new Error('CI runtime executable differs from the signed official Node distribution.');
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), expectedVersion, node: version, libuv: uv,
    platform, architecture: arch, osRelease: os.release(), executableSha256: actual,
    ...(official ? { officialArchive: official.archive } : {}),
    qualificationScope: historicalBuild ? 'historical default-heap build only; unsupported for installed application acceptance' : 'official CI runtime binary identity; installed application acceptance requires separate checks',
    signedChecksumsSha256: selected.signedChecksumsSha256, signingFingerprint: selected.signingFingerprint };
}

async function main(args) {
  const [expectedVersion, ...options] = args;
  if (new Set(options).size !== options.length || options.some((option) => !['--historical-build', '--record', '--binary-only'].includes(option))) {
    throw new Error('Usage: node scripts/verify-ci-node.mjs EXACT_VERSION [--historical-build] [--record] [--binary-only]');
  }
  if (options.includes('--binary-only') && options.includes('--historical-build')) throw new Error('Container binary measurement cannot use the historical build scope.');
  const record = await verifyCiNode({ expectedVersion, historicalBuild: options.includes('--historical-build') });
  if (options.includes('--binary-only')) {
    record.sourceSha = null;
    record.sourceQualification = 'unavailable in this container measurement; source identity must be bound separately by image evidence';
  } else {
    record.sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
    if (!/^[a-f0-9]{40}$/.test(record.sourceSha)) throw new Error('CI runtime evidence requires an exact Git source identity.');
    record.sourceTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim());
  }
  record.verifierSha256 = await hashFile(new URL(import.meta.url));
  record.binaryManifestSha256 = await hashFile(manifestPath);
  record.canonicalGuardSha256 = await hashFile(new URL('../bin/node-runtime.mjs', import.meta.url));
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (options.includes('--record')) {
    mkdirSync('ci-node-runtime', { recursive: true });
    writeFileSync(path.join('ci-node-runtime', `v${expectedVersion}.json`), text);
  }
  console.log(text.trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
