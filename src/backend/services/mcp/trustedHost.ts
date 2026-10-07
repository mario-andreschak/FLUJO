import { randomUUID } from 'node:crypto';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_INHERITED_ENV_VARS as BETA_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { TrustedHostMcpError, trustedHostEnvironment, trustedHostMcpApproval, trustedHostMcpApprovalAsync, sameTrustedHostConsent, verifyTrustedHostMcp } from '../security/trustedHostMcp';
import { mcpStringDataRecord } from '@/utils/mcp/connectionData';
import { GOAL_ENDURANCE_FIXTURE_TOKEN_ENV, resolveGoalEnduranceFixtureToken } from './goalEnduranceFixtureEnvironment';

const BROKER_NAMES = ['FLUJO_MCP_APP_RUNTIME_REGISTER_URL', 'FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN'];
const RESERVED_RUNTIME_NAMES = [...BROKER_NAMES, GOAL_ENDURANCE_FIXTURE_TOKEN_ENV, 'FLUJO_SNAPSHOT_CONTROL_TOKEN'];
const managedHosts = new WeakMap<object, ManagedTrustedHost>();

interface HostTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  __flujoInnerTransport?: unknown;
}

export interface ManagedTrustedHost {
  readonly workspace: string;
  readonly serverName: string;
  readonly generation: string;
  assertCurrent(config: MCPStdioConfig): Promise<void>;
  retire(): void;
}

/** Fixed absolute launch parameters bypass legacy runner/wrapper transformations. */
export function resolveTrustedHostLaunch(config: MCPStdioConfig) {
  const authority = trustedHostMcpApproval(config);
  const environment = new Map<string, string>();
  const names = new Set<string>();
  // Override the defaults of BOTH SDK generations, including inherited loaders.
  for (const name of [...DEFAULT_INHERITED_ENV_VARS, ...BETA_INHERITED_ENV_VARS,
    'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']) environment.set(name, '');
  for (const [name, value] of trustedHostEnvironment(config)) {
    const key = name.toUpperCase();
    if (names.has(key) || RESERVED_RUNTIME_NAMES.includes(key)) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
    names.add(key);
    if (!authority.policy.environmentNames.includes(name)) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
    if (process.platform === 'win32') {
      for (const existing of environment.keys()) if (existing.toUpperCase() === key) environment.delete(existing);
    }
    environment.set(name, value);
  }
  if (process.platform === 'win32' && !names.has('SYSTEMROOT')) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
  const fixtureToken = resolveGoalEnduranceFixtureToken(config);
  if (fixtureToken) {
    if (!authority.policy.environmentNames.includes(GOAL_ENDURANCE_FIXTURE_TOKEN_ENV)) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
    environment.set(GOAL_ENDURANCE_FIXTURE_TOKEN_ENV, fixtureToken);
  }
  return { command: config.command, args: [...(config.args ?? [])], cwd: config.cwd!, env: mcpStringDataRecord(environment) };
}

/** Only runner-issued scoped broker values can supplement the declared environment. */
export function trustedHostBrokerEnvironment(config: MCPStdioConfig, broker: Record<string, string> | undefined): Record<string, string> {
  if (!broker) return {};
  const { policy } = trustedHostMcpApproval(config);
  if (!config.enableMcpApps || Object.keys(broker).some(name => !BROKER_NAMES.includes(name) || !policy.environmentNames.includes(name))) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
  return { ...broker };
}

export function getManagedTrustedHost(transport: unknown): ManagedTrustedHost | undefined {
  const seen = new Set<object>();
  let current = transport;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const managed = managedHosts.get(current);
    if (managed) return managed;
    current = (current as HostTransport).__flujoInnerTransport;
  }
  return undefined;
}

async function currentConfig(serverName: string): Promise<MCPStdioConfig> {
  const configs = await (await import('./config')).loadServerConfigs();
  const config = Array.isArray(configs) ? configs.find(item => item.name === serverName) : undefined;
  if (!config || config.disabled || config.transport !== 'stdio') throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return config;
}

/** Capture the launched identity, not whatever later happens to be approved. */
export function attachTrustedHost(transport: HostTransport, config: MCPStdioConfig, onRetire?: () => void): void {
  const captured = structuredClone(config);
  const initial = trustedHostMcpApproval(captured);
  const fixtureToken = resolveGoalEnduranceFixtureToken(captured);
  const cancellation = new AbortController();
  let retired = false;
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  const checkLive = () => {
    if (retired || getCurrentWorkspace() !== initial.workspace) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    if (resolveGoalEnduranceFixtureToken(captured) !== fixtureToken) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  };
  const managed: ManagedTrustedHost = Object.freeze({
    workspace: initial.workspace, serverName: config.name, generation: randomUUID(),
    retire: () => { if (!retired) { retired = true; cancellation.abort(); onRetire?.(); } },
    assertCurrent: async (current: MCPStdioConfig) => {
      checkLive();
      if (current.name !== captured.name || current.disabled || !sameTrustedHostConsent(current, captured)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
      const authority = await verifyTrustedHostMcp(current, cancellation.signal);
      // Fingerprinting yields. A snapshot from before that await cannot admit
      // a server that was removed, disabled or retargeted while checking bytes.
      const latest = await currentConfig(captured.name);
      const fresh = await trustedHostMcpApprovalAsync(latest, cancellation.signal);
      const final = await currentConfig(captured.name);
      checkLive();
      if (authority.ownerId !== initial.ownerId || authority.digest !== initial.digest
          || fresh.ownerId !== initial.ownerId || fresh.digest !== initial.digest
          || !sameTrustedHostConsent(final, captured)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    },
  });
  managedHosts.set(transport, managed);
  const wrapClose = (callback: (() => void) | undefined) => () => { managed.retire(); callback?.(); };
  let onclose = wrapClose(transport.onclose);
  Object.defineProperty(transport, 'onclose', {
    configurable: true,
    get: () => onclose,
    set: (callback: (() => void) | undefined) => { onclose = wrapClose(callback); },
  });
  transport.close = async () => { managed.retire(); await close(); };
  transport.start = async () => {
    try {
      // Runtime consent performs no package preparation or installer execution.
      await managed.assertCurrent(await currentConfig(captured.name));
      const fresh = await currentConfig(captured.name);
      const authority = await trustedHostMcpApprovalAsync(fresh, cancellation.signal);
      const final = await currentConfig(captured.name);
      checkLive();
      if (authority.ownerId !== initial.ownerId || authority.digest !== initial.digest
          || !sameTrustedHostConsent(final, captured)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
      await start();
      // A revocation while the SDK awaited process startup closes this generation.
      await managed.assertCurrent(await currentConfig(captured.name));
    } catch (error) {
      managed.retire();
      try { await close(); } catch { /* cleanup uncertainty is reported by lifecycle receipts */ }
      if (error instanceof TrustedHostMcpError) throw error;
      throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    }
  };
}
