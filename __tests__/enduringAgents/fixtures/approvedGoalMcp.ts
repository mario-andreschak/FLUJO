import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource, trustedHostMcpPolicyDigest } from '@/backend/services/security/trustedHostMcp';

/** Admit the real disposable campaign server through the production private grant. */
export function installApprovedGoalMcp(fixtureDirectory: string, terminalOnly: boolean, timeoutMs: number) {
  const saved = Object.fromEntries(['FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE', 'FLUJO_MCP_ISOLATION_FILE']
    .map(name => [name, process.env[name]]));
  const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-goal-mcp-grant-'));
  const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'goal-acceptance-owned');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const dependency = createRequire(path.resolve('package.json'));
  for (const filename of ['fixture.cjs', 'terminal-fixture.cjs', 'server.mjs', 'terminal-server.mjs']) {
    let bytes = fs.readFileSync(path.resolve('scripts', 'persona-goal-acceptance', filename), 'utf8');
    // The disposable package uses the exact physically installed SDK. Import-closure
    // enforcement remains a separate production requirement; no loader is bypassed.
    if (filename.endsWith('.mjs')) bytes = bytes.replace(/from '(@modelcontextprotocol\/sdk\/[^']+)'/g,
      (_match, specifier: string) => `from ${JSON.stringify(pathToFileURL(dependency.resolve(specifier)).href)}`);
    fs.writeFileSync(path.join(sourceRoot, filename), bytes, { mode: 0o600 });
  }
  const entryPoint = path.join(sourceRoot, terminalOnly ? 'terminal-server.mjs' : 'server.mjs');
  const environment: Record<string, string> = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {};
  const config: MCPStdioConfig = { name: 'goal-acceptance', transport: 'stdio', command: process.execPath,
    args: [entryPoint, fixtureDirectory], cwd: sourceRoot, env: environment, disabled: false, rootPath: sourceRoot,
    _buildCommand: '', _installCommand: '', source: { type: 'local' },
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'node', entryPoint,
      sourceRoot, sourceDigest: fingerprintTrustedHostSource(sourceRoot), executableDigest: fingerprintTrustedHostExecutable(process.execPath),
      environmentNames: Object.keys(environment) } };
  const policyDigest = trustedHostMcpPolicyDigest(config);
  const ownerFile = path.join(privateDirectory, 'owner.json');
  const approvalFile = path.join(privateDirectory, 'approval.json');
  fs.writeFileSync(ownerFile, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-goal-fixture-owner', credentials: [] }), { mode: 0o600 });
  fs.writeFileSync(approvalFile, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-goal-fixture-owner',
    approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name, policyDigest, expiresAt: Date.now() + timeoutMs + 60_000 }] }), { mode: 0o600 });
  process.env.FLUJO_OWNER_AUTH_FILE = ownerFile;
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = approvalFile;
  delete process.env.FLUJO_MCP_ISOLATION_FILE;
  return { config, restore() {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (path.dirname(privateDirectory) !== path.resolve(os.tmpdir()) || !/^flujo-goal-mcp-grant-[A-Za-z0-9]+$/.test(path.basename(privateDirectory))
      || fs.lstatSync(privateDirectory).isSymbolicLink()) throw new Error('Unsafe private goal fixture cleanup');
    fs.rmSync(privateDirectory, { recursive: true, force: true });
  } };
}
