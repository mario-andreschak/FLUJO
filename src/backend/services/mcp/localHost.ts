import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { getExposureMode } from '@/utils/http/exposureMode';
import { TrustedHostMcpError } from '../security/trustedHostMcp';
import { launchForm } from './launchForm';

/** Preserve native localhost installations that have not selected a private policy. */
export function localHostMcpAllowed(config: MCPServerConfig): boolean {
  return config.transport === 'stdio' && !config.disabled
    && config.isolation === undefined && config.trustedHost === undefined
    && process.env.FLUJO_OWNER_AUTH_FILE === undefined
    && process.env.FLUJO_MCP_TRUSTED_HOST_FILE === undefined
    && process.env.FLUJO_MCP_ISOLATION_FILE === undefined
    && process.env.FLUJO_WORKER_MODE !== '1'
    && getExposureMode() === 'localhost';
}

interface LocalHostTransport {
  start(): Promise<void>;
  __flujoInnerTransport?: object;
}

interface LocalHostLaunch {
  /** Accepts the stored or the launch form; both are compared in launch form. */
  assertCurrent(config: MCPServerConfig): Promise<void>;
}

// Bind dispatch to a transport created by our factory, never to an arbitrary
// untracked child or a newly approved same-name server.
const registry = globalThis as typeof globalThis & {
  __flujoLocalHostMcpLaunches?: WeakMap<object, LocalHostLaunch>;
};
const launches = registry.__flujoLocalHostMcpLaunches ??= new WeakMap<object, LocalHostLaunch>();

export function getLocalHostLaunch(transport: unknown): LocalHostLaunch | undefined {
  const seen = new Set<object>();
  while (transport && typeof transport === 'object' && !seen.has(transport)) {
    seen.add(transport);
    const launch = launches.get(transport);
    if (launch) return launch;
    transport = (transport as LocalHostTransport).__flujoInnerTransport;
  }
  return undefined;
}

/** `config` is the launch form the transport starts with. */
export function attachLocalHostLaunch(transport: LocalHostTransport, config: MCPStdioConfig,
  options: { isolateRuntimeHome: boolean }): void {
  const captured = structuredClone(config);
  const workspace = getCurrentWorkspace();
  const assertAdmitted = (current: MCPServerConfig): MCPStdioConfig => {
    if (current.transport !== 'stdio' || !localHostMcpAllowed(current) || getCurrentWorkspace() !== workspace
      || current.name !== captured.name) {
      throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    }
    return current;
  };
  const launch: LocalHostLaunch = {
    async assertCurrent(given) {
      const [{ localLaunchFingerprint }, current] = await Promise.all([import('./connection'), launchForm(given)]);
      if (localLaunchFingerprint(assertAdmitted(current), options.isolateRuntimeHome)
        !== localLaunchFingerprint(assertAdmitted(captured), options.isolateRuntimeHome)) {
        throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
      }
    },
  };
  assertAdmitted(captured);
  launches.set(transport, launch);
  const start = transport.start.bind(transport);
  transport.start = async () => {
    assertAdmitted(captured);
    await start();
    assertAdmitted(captured);
  };
}
