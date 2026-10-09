import type { MCPStdioConfig } from '@/shared/types/mcp';
import { resolveRuntimeHomeIsolation } from '../mcp/runtimeHomeIsolation';
import { assertPackageRunnerResolution, packageRunnerArguments } from './protectedPackageRunner';
import { fingerprintTrustedHostExecutableAsync, fingerprintTrustedHostSourceAsync, trustedHostEnvironment,
  trustedHostMcpPolicySchema, trustedHostMcpPreviewDigestAsync, TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES, trustedHostPackageRunnerContext } from './trustedHostMcp';

/** Preview performs inspection only. The existing protected owner approval
 * transaction recomputes this proposal and publishes its private ledger grant. */
export async function previewPackageRunnerConsent(stored: MCPStdioConfig, runtimeHome: 'host' | 'isolated') {
  const policy = trustedHostMcpPolicySchema.parse(stored.trustedHost);
  if (!policy.packageRunner || policy.runtime !== 'npx') throw new Error('Package runner proposal unavailable');
  if (await resolveRuntimeHomeIsolation(stored) !== (runtimeHome === 'isolated')) throw new Error('Effective runtime home differs from the requested grant');
  const environment = Object.fromEntries(trustedHostEnvironment(stored));
  let cwd = stored.cwd;
  if (runtimeHome === 'isolated') {
    const { isolatedStdioRuntime } = await import('../mcp/connection');
    const runtime = isolatedStdioRuntime(stored.name);
    if (cwd !== runtime.cwd) throw new Error('Declare the private per-server working directory before review');
    for (const [name, value] of Object.entries(runtime.env)) {
      for (const key of Object.keys(environment)) if (key.toUpperCase() === name.toUpperCase()) delete environment[key];
      environment[name] = value;
    }
    cwd = runtime.cwd;
  }
  assertPackageRunnerResolution(policy.sourceRoot, policy.entryPoint, cwd!, policy.packageRunner, trustedHostPackageRunnerContext(stored, runtimeHome));
  const checks = await Promise.allSettled([fingerprintTrustedHostSourceAsync(policy.sourceRoot),
    fingerprintTrustedHostExecutableAsync(stored.command), fingerprintTrustedHostExecutableAsync(policy.packageRunner.shell)]);
  if (checks.some(result => result.status !== 'fulfilled')) throw new Error('Package runner source inspection failed');
  const [sourceDigest, executableDigest, shellDigest] = checks.map(result => {
    if (result.status !== 'fulfilled') throw new Error('Package runner inspection failed');
    return result.value;
  });
  const config: MCPStdioConfig = { ...stored, cwd, env: environment,
    trustedHost: { ...policy, runtimeHome, sourceDigest, executableDigest,
      packageRunner: { ...policy.packageRunner, shellDigest },
      environmentNames: [...new Set([...policy.environmentNames, ...Object.keys(environment),
        ...(runtimeHome === 'isolated' ? TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES : [])])] } };
  const policyDigest = await trustedHostMcpPreviewDigestAsync(config);
  assertPackageRunnerResolution(policy.sourceRoot, policy.entryPoint, cwd!, policy.packageRunner, trustedHostPackageRunnerContext(config, runtimeHome));
  const cache = Object.entries(environment).find(([name]) => name.toUpperCase() === 'NPM_CONFIG_CACHE')?.[1];
  if (!cache) throw new Error('Package runner cache unavailable');
  return { config, policyDigest, storedConfig: structuredClone(stored), revision: {
    sourceRoot: policy.sourceRoot, sourceDigest, executableDigest, shellDigest,
    packageRunner: policy.packageRunner,
    launchArgs: packageRunnerArguments(policy.sourceRoot, policy.packageRunner, policy.entryPoint, stored.args ?? [], cache),
  } };
}
