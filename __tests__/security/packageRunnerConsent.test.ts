import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { packageRunnerReviewDigest, type PackageRunnerReview } from '@/backend/services/security/packageRunnerConsent';
import type { MCPStdioConfig } from '@/shared/types/mcp';

const config: MCPStdioConfig = { name: 'weather-mcp', transport: 'stdio', command: 'npx',
  args: ['-y', '@example/weather-mcp'], rootPath: 'mcp-servers/weather-mcp', env: {}, disabled: false,
  _buildCommand: '', _installCommand: '' };
function review(): PackageRunnerReview {
  const runtimeRoot = path.join(getWorkspaceDataDir(), 'userdata', 'mcp-runtime', createHash('sha256').update(config.name).digest('hex').slice(0, 24));
  const cwd = path.join(runtimeRoot, 'cwd'), home = path.join(runtimeRoot, 'home');
  const packageRoot = path.join(cwd, 'node_modules', '@example', 'weather-mcp');
  const digest = 'a'.repeat(64);
  return { schemaVersion: 1, kind: 'package-runner', privileges: 'owner-account', runtimeHome: 'isolated',
    workspace: getCurrentWorkspace(), serverName: config.name, runtimeRoot, cwd, home,
    requestedPackage: '@example/weather-mcp', resolvedVersion: '1.2.3', packageRoot,
    packageIntegrity: 'sha512-YQ==', packageTreeSha256: digest, dependencyGraphSha256: digest, lockfileSha256: digest,
    packageBin: path.join(packageRoot, 'cli.js'), launcher: { path: path.resolve('npx-launcher'), sha256: digest },
    node: { path: process.execPath, sha256: digest }, npmSourceRoot: path.resolve('npm-source'), npmSourceSha256: digest,
    npmConfigurationSha256: digest, lookupStateSha256: digest, environment: { HOME: home, USERPROFILE: home } };
}
it('commits the unchanged original npx request and exact proposed package revision', () => {
  const input = review();
  const digest = packageRunnerReviewDigest(config, input);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(packageRunnerReviewDigest(config, { ...input, resolvedVersion: '1.2.4' })).not.toBe(digest);
  expect(packageRunnerReviewDigest(config, { ...input, lookupStateSha256: 'b'.repeat(64) })).not.toBe(digest);
});
it('does not permit Node substitution, unbound package specs or sibling runtime roots', () => {
  expect(() => packageRunnerReviewDigest({ ...config, command: 'node' }, review())).toThrow();
  expect(() => packageRunnerReviewDigest(config, { ...review(), requestedPackage: '@example/other' })).toThrow();
  expect(() => packageRunnerReviewDigest(config, { ...review(), runtimeRoot: path.join(getWorkspaceDataDir(), 'other') })).toThrow();
});
it('refuses version ranges, escaping bins and code-loading overrides', () => {
  expect(() => packageRunnerReviewDigest(config, { ...review(), resolvedVersion: '*' })).toThrow();
  expect(() => packageRunnerReviewDigest(config, { ...review(), packageBin: process.execPath })).toThrow();
  const input = review();
  expect(() => packageRunnerReviewDigest(config, { ...input, environment: { ...input.environment, NODE_OPTIONS: '--require attacker' } })).toThrow();
});
