import { createHash, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { readPlainFile } from '@/utils/readPlainFile';
import { trustedHostEnvironment } from './trustedHostMcp';
import { prepareResolvedPackageTree, revalidateResolvedPackageTree } from './packageRunnerResolution';
import { preparePackageRunnerLookup, revalidatePackageRunnerLookup, type PackageRunnerLookupRequest } from './packageRunnerLookup';
import { inspectPackageRunnerNativeStage } from './packageRunnerNativeStage';
import { inspectControlledPackageRunnerAssets } from './packageRunnerShims';
import { inspectPackageRunnerNpmEvidence } from './packageRunnerNpmEvidence';

export interface PackageRunnerPreparation {
  revision: string;
  lookup: PackageRunnerLookupRequest;
  launcher: string;
  node: string;
  shell: string;
  artifactFiles: Readonly<Record<string, string>>;
  upstreamNpmRoot: string;
  binShim: string;
  binName: string;
  environment: Readonly<Record<string, string>>;
}
export interface PreparedPackageRunnerIntent { readonly digest: string }
type Evidence = Awaited<ReturnType<typeof collect>>;
const intents = new WeakMap<object, { request: string; preparation: PackageRunnerPreparation; evidence: Evidence }>();
export function packageRunnerIntentSubject(intent: PreparedPackageRunnerIntent, config: MCPStdioConfig) {
  const state = intents.get(intent);
  if (!state || state.request !== requestIdentity(config)) throw new Error('Unknown or changed package runner intent');
  return Object.freeze({ workspace: getCurrentWorkspace(), serverName: config.name, revision: state.preparation.revision,
    digest: intent.digest, resolver: 'modified-npm' as const });
}
function requestIdentity(config: MCPStdioConfig) {
  return JSON.stringify({ workspace: getCurrentWorkspace(), config: { name: config.name, command: config.command,
    args: config.args, cwd: config.cwd, rootPath: config.rootPath, roots: config.roots,
    env: [...trustedHostEnvironment(config)].sort(([a], [b]) => a.localeCompare(b)),
    enableMcpApps: config.enableMcpApps, enableMcpSkills: config.enableMcpSkills,
    sampling: config.sampling, elicitation: config.elicitation } });
}
async function executable(filename: string, signal?: AbortSignal) {
  if (!path.isAbsolute(filename)) throw new Error('Package runner executable is not absolute');
  const verify = async () => {
    let parent = path.dirname(filename);
    for (;;) {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked package runner executable parent');
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
  };
  const hash = createHash('sha256');
  await readPlainFile(filename, { signal, maxBytes: 512 * 1024 * 1024, verifyPath: verify,
    consume: async chunk => { hash.update(chunk); } });
  return { path: filename, sha256: hash.digest('hex') };
}
async function collect(config: MCPStdioConfig, preparation: PackageRunnerPreparation, signal?: AbortSignal) {
  if (config.command !== 'npx' || config.args?.length !== 2 || config.args[0] !== '-y'
      || !preparation.revision || preparation.revision.length > 256) throw new Error('Unsupported original package request');
  const runtime = path.join(getWorkspaceDataDir(), 'userdata', 'mcp-runtime',
    createHash('sha256').update(config.name, 'utf8').digest('hex').slice(0, 24));
  if (path.resolve(preparation.lookup.cwd) !== path.join(runtime, 'cwd')
      || path.resolve(preparation.lookup.home) !== path.join(runtime, 'home')) throw new Error('Package runtime binding changed');
  for (const filename of [preparation.lookup.npmRoot, preparation.upstreamNpmRoot, preparation.binShim,
    preparation.lookup.cache, preparation.lookup.globalBin,
    preparation.launcher, preparation.node, preparation.shell, ...preparation.lookup.configFiles]) {
    const relative = path.relative(runtime, path.resolve(filename));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Runner resolution/effect dependency is outside the protected private stage');
    }
  }
  const nativeStage = await inspectPackageRunnerNativeStage(runtime, signal);
  const environment = preparation.environment;
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_PREFIX',
    'NPM_CONFIG_SCRIPT_SHELL', 'NPM_CONFIG_OFFLINE', 'NPM_CONFIG_IGNORE_SCRIPTS', 'NPM_CONFIG_WORKSPACES',
    'NPM_CONFIG_UPDATE_NOTIFIER', 'NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND']);
  if (!environment || Object.keys(environment).some(key => !allowed.has(key))
      || Object.values(environment).some(value => typeof value !== 'string' || value.length > 32768 || value.includes('\0'))
      || environment.HOME !== preparation.lookup.home || environment.USERPROFILE !== preparation.lookup.home
      || environment.PATH !== [path.dirname(preparation.node), path.dirname(preparation.shell)].join(path.delimiter)
      || environment.COMSPEC !== preparation.shell || environment.NPM_CONFIG_SCRIPT_SHELL !== preparation.shell
      || environment.NPM_CONFIG_CACHE !== preparation.lookup.cache
      || !preparation.lookup.configFiles.includes(environment.NPM_CONFIG_USERCONFIG)
      || !preparation.lookup.configFiles.includes(environment.NPM_CONFIG_GLOBALCONFIG)
      || environment.NPM_CONFIG_PREFIX !== preparation.lookup.globalBin
      || environment.NPM_CONFIG_OFFLINE !== 'true' || environment.NPM_CONFIG_IGNORE_SCRIPTS !== 'true'
      || environment.NPM_CONFIG_WORKSPACES !== 'false' || environment.NPM_CONFIG_UPDATE_NOTIFIER !== 'false'
      || environment.NPM_CONFIG_AUDIT !== 'false' || environment.NPM_CONFIG_FUND !== 'false'
      || environment.SystemRoot !== process.env.SystemRoot || environment.WINDIR !== process.env.SystemRoot
      || [environment.TEMP, environment.TMP].some(filename => !filename || path.dirname(path.resolve(filename)) !== preparation.lookup.home)) {
    throw new Error('Runner environment is not the exact closed reviewed environment');
  }
  // Sequential real observations; no submitted digest becomes evidence.
  if (!preparation.artifactFiles) throw new Error('Actual dependency archives are required for a runner intent');
  const tree = await prepareResolvedPackageTree(preparation.lookup.cwd, config.args[1], signal, preparation.artifactFiles);
  const lookup = await preparePackageRunnerLookup(preparation.lookup, signal);
  // Freeze actual full upstream module/license bytes as well as the staged
  // modified npm closure. A single replacement anchor cannot stand for either.
  const upstreamLookup = await preparePackageRunnerLookup({ ...preparation.lookup,
    npmRoot: preparation.upstreamNpmRoot }, signal);
  const upstreamNpm = await inspectPackageRunnerNpmEvidence(preparation.upstreamNpmRoot, signal);
  const stagedNpm = await inspectPackageRunnerNpmEvidence(preparation.lookup.npmRoot, signal);
  if (JSON.stringify(upstreamNpm) !== JSON.stringify(stagedNpm)) throw new Error('Controlled npm metadata/license differs from actual upstream distribution');
  const launcher = await executable(preparation.launcher, signal);
  const node = await executable(preparation.node, signal);
  const shell = await executable(preparation.shell, signal);
  const controlledAssetsInput = { node: preparation.node, npmRoot: preparation.lookup.npmRoot,
    upstreamNpmRoot: preparation.upstreamNpmRoot, launcher: preparation.launcher, packageBin: tree.bin,
    binShim: preparation.binShim, binName: preparation.binName, cwd: preparation.lookup.cwd,
    packageName: tree.packageName, version: tree.version };
  const controlledAssets = await inspectControlledPackageRunnerAssets(controlledAssetsInput, signal);
  if (await inspectPackageRunnerNativeStage(runtime, signal) !== nativeStage) throw new Error('Native runner stage authority changed');
  return { tree, lookup, upstreamLookup, upstreamNpm, stagedNpm, launcher, node, shell,
    nativeStage, runtime, controlledAssets, controlledAssetsInput };
}

/** Opaque inspection intent, deliberately separate from consent/launch authority. */
export async function preparePackageRunnerIntent(config: MCPStdioConfig, input: PackageRunnerPreparation,
  signal?: AbortSignal): Promise<PreparedPackageRunnerIntent> {
  const preparation = structuredClone(input);
  const request = requestIdentity(config);
  const evidence = await collect(config, preparation, signal);
  if (requestIdentity(config) !== request) throw new Error('Original package request changed during inspection');
  // The request includes reviewed environment secrets. Preserve the slow-hash
  // contract of consent review rather than expose a cheap dictionary oracle.
  const digest = scryptSync(JSON.stringify({ domain: 'flujo:package-runner-intent:v1',
    request, preparation, evidence }), JSON.stringify([getCurrentWorkspace(), config.name, preparation.revision]),
  32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  const intent = Object.freeze({ digest });
  intents.set(intent, { request, preparation, evidence });
  return intent;
}

export async function revalidatePackageRunnerIntent(intent: PreparedPackageRunnerIntent, config: MCPStdioConfig,
  revision: string, signal?: AbortSignal): Promise<void> {
  const state = intents.get(intent);
  if (!state || state.request !== requestIdentity(config) || revision !== state.preparation.revision) {
    throw new Error('Package runner intent/request/revision mismatch');
  }
  await revalidateResolvedPackageTree(state.evidence.tree, signal);
  await revalidatePackageRunnerLookup(state.evidence.lookup, signal);
  await revalidatePackageRunnerLookup(state.evidence.upstreamLookup, signal);
  if (JSON.stringify(await inspectPackageRunnerNpmEvidence(state.preparation.upstreamNpmRoot, signal)) !== JSON.stringify(state.evidence.upstreamNpm)
      || JSON.stringify(await inspectPackageRunnerNpmEvidence(state.preparation.lookup.npmRoot, signal)) !== JSON.stringify(state.evidence.stagedNpm)) {
    throw new Error('Actual npm distribution identity/license changed');
  }
  for (const prior of [state.evidence.launcher, state.evidence.node, state.evidence.shell]) {
    if (JSON.stringify(await executable(prior.path, signal)) !== JSON.stringify(prior)) throw new Error('Package runner executable changed');
  }
  if (state.request !== requestIdentity(config)) throw new Error('Package request changed during revalidation');
  if (await inspectControlledPackageRunnerAssets(state.evidence.controlledAssetsInput, signal) !== state.evidence.controlledAssets) {
    throw new Error('Actual controlled runner assets changed');
  }
  if (await inspectPackageRunnerNativeStage(state.evidence.runtime, signal) !== state.evidence.nativeStage) {
    throw new Error('Native runner stage authority changed after preparation');
  }
  if (state.request !== requestIdentity(config)) throw new Error('Package request changed during native revalidation');
}

// No spawn/exported grant issuer exists here. A prepared intent cannot authorize
// an ordinary npx process: native protected-stage authority, exact npm resolver
// interpretation and OS containment of fallback/reify/network are not supplied
// by filesystem fingerprints. Production's existing npx denial remains intact.
export function packageRunnerIntentLaunchParameters(intent: PreparedPackageRunnerIntent, config: MCPStdioConfig) {
  const state = intents.get(intent);
  packageRunnerIntentSubject(intent, config);
  if (!state || path.basename(state.preparation.shell).toLowerCase() !== 'cmd.exe'
      || /[\0\r\n"'`$%!&|<>^]/.test(state.preparation.launcher)) throw new Error('Fixed controlled launcher unavailable');
  return Object.freeze({ command: state.preparation.shell,
    args: ['/d', '/s', '/c', `""${state.preparation.launcher}" -y ${config.args![1]}"`],
    cwd: state.preparation.lookup.cwd, env: Object.freeze({ ...state.preparation.environment }) });
}
