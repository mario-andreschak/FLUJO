import path from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { z } from 'zod';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { trustedHostEnvironment } from './trustedHostMcp';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().min(1).max(2048).refine(value => path.isAbsolute(value) && !value.includes('\0'));
const executable = z.object({ path: absolute, sha256: digest }).strict();
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);

/** Review inputs only. Parsing/digesting this object never grants launch authority. */
export const packageRunnerReviewSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('package-runner'),
  privileges: z.literal('owner-account'), runtimeHome: z.literal('isolated'),
  workspace: z.string().min(1).max(128), serverName: z.string().min(1).max(256),
  runtimeRoot: absolute, cwd: absolute, home: absolute,
  requestedPackage: packageName, resolvedVersion: z.string().max(128).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  packageRoot: absolute, packageIntegrity: z.string().max(256).regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  packageTreeSha256: digest, dependencyGraphSha256: digest, lockfileSha256: digest,
  packageBin: absolute,
  launcher: executable, node: executable, shell: executable.optional(),
  npmSourceRoot: absolute, npmSourceSha256: digest,
  npmConfigurationSha256: digest, lookupStateSha256: digest,
  // These fingerprints must cover actual npm configuration, local/global/bin
  // and ancestor searches. Offline flags alone do not establish identity.
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(32768))
    .refine(value => Object.keys(value).length <= 64),
}).strict();
export type PackageRunnerReview = z.infer<typeof packageRunnerReviewSchema>;

function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Commit the original npx request and proposed final launch, without executing it. */
export function packageRunnerReviewDigest(config: MCPStdioConfig, input: unknown): string {
  const review = packageRunnerReviewSchema.parse(input);
  const workspaceRoot = getWorkspaceDataDir();
  const runtimeRoot = path.join(workspaceRoot, 'userdata', 'mcp-runtime', createHash('sha256').update(config.name, 'utf8').digest('hex').slice(0, 24));
  if (config.command !== 'npx' || JSON.stringify(config.args) !== JSON.stringify(['-y', review.requestedPackage])
      || review.workspace !== getCurrentWorkspace() || review.serverName !== config.name
      || path.resolve(review.runtimeRoot) !== runtimeRoot
      || path.resolve(review.cwd) !== path.join(review.runtimeRoot, 'cwd')
      || path.resolve(review.home) !== path.join(review.runtimeRoot, 'home')
      || !within(review.cwd, review.packageRoot) || !within(review.packageRoot, review.packageBin)
      || review.environment.HOME !== review.home || review.environment.USERPROFILE !== review.home) {
    throw new Error('Package-runner review does not bind the original request and private runtime.');
  }
  for (const name of Object.keys(review.environment)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'].includes(name.toUpperCase())) {
      throw new Error('Package-runner review contains an undeclared code-loading override.');
    }
  }
  const requestedEnvironment = [...trustedHostEnvironment(config)].sort(([a], [b]) => a.localeCompare(b));
  const finalEnvironment = Object.entries(review.environment).sort(([a], [b]) => a.localeCompare(b));
  const content = JSON.stringify({ domain: 'flujo:mcp:package-runner-review:v1',
    request: { command: config.command, args: config.args, rootPath: config.rootPath, cwd: config.cwd,
      requestedEnvironment, roots: config.roots ?? [], apps: config.enableMcpApps === true,
      skills: config.enableMcpSkills === true, sampling: config.sampling ?? null, elicitation: config.elicitation ?? null },
    review: { ...review, environment: finalEnvironment } });
  return scryptSync(content, JSON.stringify([review.workspace, review.serverName, review.runtimeRoot]), 32,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}
