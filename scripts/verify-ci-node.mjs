import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

/** Measures official executable bytes before dependency, build or publication commands. */
export async function verifyCiNode({ expectedVersion, historicalBuild = false,
  version = process.versions.node, uv = process.versions.uv,
  platform = process.platform, arch = process.arch, executable = process.execPath,
  binaries = manifest, nodeOptions = process.env.NODE_OPTIONS ?? '', execArgv = process.execArgv } = {}) {
  if (!Object.values(CI_NODE_PROFILES).includes(expectedVersion) || version !== expectedVersion) {
    throw new Error('CI Node version differs from the exact selected runtime.');
  }
  if (historicalBuild && expectedVersion !== CI_NODE_PROFILES.historicalBuild) {
    throw new Error('Historical build evidence is restricted to Node 22.13.1.');
  }
  if (!historicalBuild) assertSupportedNodeRuntime(version);
  if (nodeOptions || execArgv.length) throw new Error('CI runtime verification requires ordinary Node options and default heap.');
  if (arch !== 'x64' || !['linux', 'win32'].includes(platform)) throw new Error('CI runtime binary has an unsupported platform.');
  const selected = binaries.runtimes?.[expectedVersion];
  const expected = selected?.executables?.[platform];
  if (binaries.schemaVersion !== 1 || selected?.uv !== uv || !/^[a-f0-9]{64}$/.test(expected ?? '')) {
    throw new Error('CI runtime has missing or mismatched official binary/libuv evidence.');
  }
  const actual = await hashFile(realpathSync.native(executable));
  if (actual !== expected) throw new Error('CI runtime executable differs from the signed official Node distribution.');
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), expectedVersion, node: version, libuv: uv,
    platform, architecture: arch, osRelease: os.release(), executableSha256: actual,
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
