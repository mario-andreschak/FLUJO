import { randomUUID } from 'node:crypto';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_INHERITED_ENV_VARS as BETA_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { TrustedHostMcpError, trustedHostEnvironment, trustedHostMcpApproval, trustedHostMcpApprovalAsync, trustedHostMcpPolicySchema, sameTrustedHostConsent, verifyTrustedHostMcp } from '../security/trustedHostMcp';
import { mcpStringDataRecord } from '@/utils/mcp/connectionData';
import { GOAL_ENDURANCE_FIXTURE_TOKEN_ENV, resolveGoalEnduranceFixtureToken } from './goalEnduranceFixtureEnvironment';
import { activatePendingWorkload, getPendingWorkloadEnvironment, revokePendingWorkload, type PendingBundledFlujoWorkload } from '../security/bundledFlujoWorkload';

const BROKER_NAMES = ['FLUJO_MCP_APP_RUNTIME_REGISTER_URL', 'FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN'];
const RESERVED_RUNTIME_NAMES = [...BROKER_NAMES, GOAL_ENDURANCE_FIXTURE_TOKEN_ENV, 'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_WORKER_MODE', 'FLUJO_MCP_WORKLOAD_TOKEN', 'FLUJO_MCP_WORKLOAD_AUDIENCE'];
const managedHosts = new WeakMap<object, ManagedTrustedHost>();
interface VerifiedWorkloadStart { config: MCPStdioConfig; generation: string; ownerId: string; digest: string; assertLive(): void }
const workloadStartProofs = new WeakMap<object, { capsule: PendingBundledFlujoWorkload; verified: VerifiedWorkloadStart }>();
export function assertVerifiedBundledFlujoWorkloadStart(proof: unknown, capsule: PendingBundledFlujoWorkload): VerifiedWorkloadStart {
  const selected = proof && typeof proof === 'object' ? workloadStartProofs.get(proof) : undefined;
  if (!selected || selected.capsule !== capsule) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  selected.verified.assertLive();
  return selected.verified;
}

function workerRuntimeCredentials(config: MCPStdioConfig): Record<string, string> {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  if (process.env.FLUJO_WORKER_MODE !== '1' || policy.bundledInstallation?.packageDirectory !== 'flujo') return {};
  const environment = trustedHostEnvironment(config);
  const configured = new URL(environment.get('FLUJO_BASE_URL') || 'http://127.0.0.1:4200');
  const audience = new URL(process.env.FLUJO_BASE_URL || 'http://127.0.0.1:4200');
  if (!['http:', 'https:'].includes(configured.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)
      || configured.username || configured.password || configured.href !== audience.href
      || environment.get('FLUJO_WORKSPACE') !== getCurrentWorkspace()
      || !policy.environmentNames.includes('FLUJO_WORKER_MODE') || !policy.environmentNames.includes('FLUJO_SNAPSHOT_CONTROL_TOKEN')
      || !process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim()) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
  return { FLUJO_WORKER_MODE: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN };
}

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
  for (const [name, value] of Object.entries(workerRuntimeCredentials(config))) environment.set(name, value);
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
export function attachTrustedHost(transport: HostTransport, config: MCPStdioConfig, onRetire?: () => void, workload?: PendingBundledFlujoWorkload): void {
  const captured = structuredClone(config);
  const initial = trustedHostMcpApproval(captured);
  const fixtureToken = resolveGoalEnduranceFixtureToken(captured);
  const workerCredentials = workerRuntimeCredentials(captured);
  if (process.env.FLUJO_WORKER_MODE !== '1' && initial.policy.bundledInstallation?.packageDirectory === 'flujo' && !workload) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const workloadEnvironment = getPendingWorkloadEnvironment(captured, workload);
  const cancellation = new AbortController();
  let retired = false;
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  const checkLive = () => {
    if (retired || getCurrentWorkspace() !== initial.workspace) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    if (resolveGoalEnduranceFixtureToken(captured) !== fixtureToken) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    if (JSON.stringify(workerRuntimeCredentials(captured)) !== JSON.stringify(workerCredentials)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    if (JSON.stringify(getPendingWorkloadEnvironment(captured, workload)) !== JSON.stringify(workloadEnvironment)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  };
  const managed: ManagedTrustedHost = Object.freeze({
    workspace: initial.workspace, serverName: config.name, generation: randomUUID(),
    retire: () => {
      const errors: unknown[] = [];
      try { revokePendingWorkload(workload); } catch (error) { errors.push(error); }
      if (!retired) {
        retired = true; cancellation.abort();
        try { onRetire?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Trusted host retirement failed.');
    },
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
  const wrapClose = (callback: (() => void) | undefined) => () => {
    const errors: unknown[] = [];
    try { managed.retire(); } catch (error) { errors.push(error); }
    try { callback?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Trusted host close callback failed.');
  };
  let onclose = wrapClose(transport.onclose);
  Object.defineProperty(transport, 'onclose', {
    configurable: true,
    get: () => onclose,
    set: (callback: (() => void) | undefined) => { onclose = wrapClose(callback); },
  });
  transport.close = async () => {
    const errors: unknown[] = [];
    try { managed.retire(); } catch (error) { errors.push(error); }
    try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Trusted host close failed.');
  };
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
      if (workload) {
        const proof = Object.freeze({});
        workloadStartProofs.set(proof, { capsule: workload, verified: Object.freeze({ config: captured,
          generation: managed.generation, ownerId: initial.ownerId, digest: initial.digest, assertLive: checkLive }) });
        try { await activatePendingWorkload(workload, proof); } finally { workloadStartProofs.delete(proof); }
        await managed.assertCurrent(await currentConfig(captured.name));
        checkLive();
      }
      await start();
      // A revocation while the SDK awaited process startup closes this generation.
      await managed.assertCurrent(await currentConfig(captured.name));
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { managed.retire(); } catch (cleanup) { cleanupErrors.push(cleanup); }
      try { await close(); } catch (cleanup) { cleanupErrors.push(cleanup); }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Trusted host start and cleanup failed.', { cause: error });
      if (error instanceof TrustedHostMcpError) throw error;
      throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    }
  };
}
