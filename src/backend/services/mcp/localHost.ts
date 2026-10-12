import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { getExposureMode } from '@/utils/http/exposureMode';
import { TrustedHostMcpError } from '../security/trustedHostMcp';

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
  assertCurrent(config: MCPServerConfig): void;
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

export function attachLocalHostLaunch(transport: LocalHostTransport, config: MCPStdioConfig,
  identity: (config: MCPStdioConfig) => string): void {
  const captured = structuredClone(config);
  const workspace = getCurrentWorkspace();
  const key = identity(captured);
  const launch: LocalHostLaunch = {
    assertCurrent(current) {
      if (current.transport !== 'stdio' || !localHostMcpAllowed(current) || getCurrentWorkspace() !== workspace
        || current.name !== captured.name || identity(current) !== key) {
        throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
      }
    },
  };
  launch.assertCurrent(captured);
  launches.set(transport, launch);
  const start = transport.start.bind(transport);
  transport.start = async () => {
    launch.assertCurrent(captured);
    await start();
    launch.assertCurrent(captured);
  };
}
