import path from 'node:path';
import type { MCPHostPathAccessConfig, MCPStdioConfig } from '@/shared/types/mcp';

export type ShippedMcpServerDescriptor = {
  defaultName: string;
  packageId: string;
  packageDirectory: string;
  disabledByDefault?: (env: NodeJS.ProcessEnv) => boolean;
  enableMcpApps?: boolean;
  hostPathAccess?: MCPHostPathAccessConfig;
};

/**
 * Installer records for the MCP packages distributed with FLUJO. These names are
 * only defaults used when provisioning a record; runtime behavior is driven by
 * the persisted config, so users may rename or delete every installed server.
 */
export const SHIPPED_MCP_SERVERS: readonly ShippedMcpServerDescriptor[] = [
  {
    defaultName: 'flujo',
    packageId: '@flujo-ai/mcp-flujo',
    packageDirectory: 'flujo',
  },
  {
    defaultName: 'filesystem',
    packageId: '@flujo-ai/mcp-filesystem',
    packageDirectory: 'filesystem',
    hostPathAccess: {
      environmentRootVariables: ['FLUJO_FS_ROOTS'],
      protectedPaths: true,
      snapshots: true,
    },
  },
  {
    defaultName: 'bash',
    packageId: '@flujo-ai/mcp-bash',
    packageDirectory: 'bash',
    hostPathAccess: {
      environmentRootVariables: ['FLUJO_BASH_ROOTS', 'FLUJO_FS_ROOTS'],
      protectedPaths: true,
      snapshots: true,
    },
  },
  {
    defaultName: 'browser',
    packageId: '@flujo-ai/mcp-browser',
    packageDirectory: 'browser',
    enableMcpApps: true,
    disabledByDefault: (env) => !/^(1|true|yes|on)$/i.test(
      env.FLUJO_BROWSER_ENABLED?.trim() ?? '',
    ),
  },
] as const;

export function shippedMcpAppRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.FLUJO_APP_ROOT?.trim() || process.cwd());
}

/** Forward only the operator controls needed by the standalone child process. */
export function shippedServerEnv(
  descriptor: ShippedMcpServerDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {
    FLUJO_DATA_DIR: env.FLUJO_DATA_DIR ?? process.cwd(),
  };
  const forwarded = new Set([
    'FLUJO_BASE_URL',
    'FLUJO_EXTRA_CA_CERTS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'SSL_CERT_FILE',
  ]);

  if (descriptor.defaultName === 'filesystem') {
    forwarded.add('FLUJO_FS_ROOTS');
    forwarded.add('FLUJO_ALLOW_PROTECTED_PATHS');
  } else if (descriptor.defaultName === 'bash') {
    forwarded.add('FLUJO_BASH_ROOTS');
    forwarded.add('FLUJO_FS_ROOTS');
    forwarded.add('FLUJO_BASH_INHERIT_ENV');
    forwarded.add('FLUJO_ALLOW_PROTECTED_PATHS');
    if (/^(1|true|yes|on)$/i.test(env.FLUJO_BASH_INHERIT_ENV?.trim() ?? '')) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') result[key] = value;
      }
    }
  } else if (descriptor.defaultName === 'browser') {
    for (const key of [
      'FLUJO_BROWSER_ENABLED',
      'FLUJO_BROWSER_ALLOWED_ORIGINS',
      'FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS',
      'FLUJO_BROWSER_EXECUTABLE_PATH',
      'FLUJO_BROWSER_MAX_SESSIONS',
      'FLUJO_BROWSER_IDLE_TIMEOUT_MS',
      'FLUJO_BROWSER_MAX_REDIRECTS',
    ]) forwarded.add(key);
  }

  for (const key of forwarded) {
    const value = env[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

/** Build the ordinary persisted stdio record installed for one shipped package. */
export function createShippedServerConfig(
  descriptor: ShippedMcpServerDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): MCPStdioConfig {
  const appRoot = shippedMcpAppRoot(env);
  return {
    name: descriptor.defaultName,
    transport: 'stdio',
    command: 'node',
    args: [path.join('mcp-servers', descriptor.packageDirectory, 'dist', 'index.js')],
    env: shippedServerEnv(descriptor, env),
    cwd: appRoot,
    disabled: descriptor.disabledByDefault?.(env) ?? false,
    autoApprove: [],
    rootPath: '',
    roots: [],
    _buildCommand: '',
    _installCommand: '',
    source: { type: 'marketplace', id: descriptor.packageId },
    exposeAsMcpServer: true,
    enableMcpApps: descriptor.enableMcpApps ?? false,
    ...(descriptor.hostPathAccess
      ? { hostPathAccess: descriptor.hostPathAccess }
      : {}),
  };
}
