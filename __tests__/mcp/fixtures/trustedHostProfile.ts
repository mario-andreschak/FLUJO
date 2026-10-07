import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource, trustedHostMcpPolicyDigest } from '@/backend/services/security/trustedHostMcp';

/** Real private grant/files for tests that model SDK effects; no code is executed. */
export function installTrustedHostProfile(options: { name?: string; roots?: string[]; environment?: Record<string, string> } = {}) {
  const saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE', 'FLUJO_MCP_ISOLATION_FILE'].map(name => [name, process.env[name]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-approved-host-'));
  process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_MCP_ISOLATION_FILE;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(directory, 'approval.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-fixture-owner', credentials: [] }), { mode: 0o600 });
  const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'approved-fixture');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const command = path.join(sourceRoot, 'synthetic-executable');
  fs.writeFileSync(command, 'fingerprinted fixture; never executed');
  const alternateCommand = path.join(sourceRoot, 'synthetic-alternate-executable');
  fs.writeFileSync(alternateCommand, 'distinct fingerprinted fixture; never executed');
  const env = { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}), ...options.environment };
  const config: MCPStdioConfig = { name: options.name ?? 'approved-host-fixture', transport: 'stdio', command, args: [], cwd: sourceRoot,
    env, disabled: false, roots: options.roots ?? [], rootPath: '', _buildCommand: '', _installCommand: '',
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'native', entryPoint: command,
      sourceRoot, sourceDigest: fingerprintTrustedHostSource(sourceRoot), executableDigest: fingerprintTrustedHostExecutable(command), environmentNames: Object.keys(env) } };
  const approve = (requested: MCPStdioConfig = config) => {
    fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-fixture-owner',
      approvals: [{ workspace: getCurrentWorkspace(), serverName: requested.name, policyDigest: trustedHostMcpPolicyDigest(requested), expiresAt: Date.now() + 120_000 }] }), { mode: 0o600 });
  };
  approve();
  return {
    config, approve, alternateCommand,
    restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !/^flujo-approved-host-[A-Za-z0-9]+$/.test(path.basename(directory)) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe approved fixture cleanup');
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
