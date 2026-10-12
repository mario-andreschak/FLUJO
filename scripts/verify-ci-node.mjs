import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSupportedNodeRuntime } from '../bin/node-runtime.mjs';

export const CI_NODE_PROFILES = Object.freeze({
  historicalBuild: '22.13.1', minimum22: '22.17.0', current22: '22.23.3',
  minimum24: '24.2.0', current24: '24.21.0',
});
const manifestPath = new URL('./ci-node-binaries.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

export function assertCiContainerContract(source) {
  source = source.replaceAll('\r\n', '\n');
  const stages = source.split(/^FROM /m).slice(1);
  if (stages.length !== 2 || !stages[0].startsWith(`${manifest.containerBase.reference} AS builder\n`)
      || !stages[1].startsWith(`${manifest.containerBase.reference} AS runtime\n`)) {
    throw new Error('Both container stages must use the exact observed current patched Node base digest.');
  }
  const command = `RUN node scripts/verify-ci-node.mjs ${CI_NODE_PROFILES.current22} --binary-only\n`;
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
