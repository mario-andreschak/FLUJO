import { createHash, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { readPlainFile } from '@/utils/readPlainFile';
import { trustedHostEnvironment } from './trustedHostMcp';
import { prepareResolvedPackageTree, revalidateResolvedPackageTree } from './packageRunnerResolution';
import { preparePackageRunnerLookup, revalidatePackageRunnerLookup, type PackageRunnerLookupRequest } from './packageRunnerLookup';

export interface PackageRunnerPreparation {
  revision: string;
  lookup: PackageRunnerLookupRequest;
  launcher: string;
  node: string;
  shell: string;
  artifactFiles: Readonly<Record<string, string>>;
}
export interface PreparedPackageRunnerIntent { readonly digest: string }
type Evidence = Awaited<ReturnType<typeof collect>>;
const intents = new WeakMap<object, { request: string; preparation: PackageRunnerPreparation; evidence: Evidence }>();
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
  // Sequential real observations; no submitted digest becomes evidence.
  if (!preparation.artifactFiles) throw new Error('Actual dependency archives are required for a runner intent');
  const tree = await prepareResolvedPackageTree(preparation.lookup.cwd, config.args[1], signal, preparation.artifactFiles);
  const lookup = await preparePackageRunnerLookup(preparation.lookup, signal);
  const launcher = await executable(preparation.launcher, signal);
  const node = await executable(preparation.node, signal);
  const shell = await executable(preparation.shell, signal);
  return { tree, lookup, launcher, node, shell };
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
  for (const prior of [state.evidence.launcher, state.evidence.node, state.evidence.shell]) {
    if (JSON.stringify(await executable(prior.path, signal)) !== JSON.stringify(prior)) throw new Error('Package runner executable changed');
  }
  if (state.request !== requestIdentity(config)) throw new Error('Package request changed during revalidation');
}

// No spawn/exported grant issuer exists here. A prepared intent cannot authorize
// an ordinary npx process: native protected-stage authority, exact npm resolver
// interpretation and OS containment of fallback/reify/network are not supplied
// by filesystem fingerprints. Production's existing npx denial remains intact.
