import path from 'node:path';
import type { MCPHostPathAccessConfig, MCPServerIcon, MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';

type Environment = Readonly<Record<string, string | undefined>>;

export type ShippedMcpServerDescriptor = {
  defaultName: string;
  packageId: string;
  legacyPackageIds?: readonly string[];
  packageDirectory: string;
  disabledByDefault?: (env: Environment) => boolean;
  enableMcpApps?: boolean;
  icons: MCPServerIcon[];
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
    packageId: '@mario.andreschak/mcp-flujo',
    packageDirectory: 'flujo',
    icons: [{ src: '/mcp-icons/flujo.svg', mimeType: 'image/svg+xml' }],
  },
  {
    defaultName: 'filesystem',
    packageId: '@mario.andreschak/mcp-filesystem',
    packageDirectory: 'filesystem',
    icons: [{ src: '/mcp-icons/filesystem.svg', mimeType: 'image/svg+xml' }],
    hostPathAccess: {
      environmentRootVariables: ['FLUJO_FS_ROOTS'],
      protectedPaths: true,
      snapshots: true,
    },
  },
  {
    defaultName: 'bash',
    packageId: '@mario.andreschak/mcp-bash',
    packageDirectory: 'bash',
    icons: [{ src: '/mcp-icons/bash.svg', mimeType: 'image/svg+xml' }],
    enableMcpApps: true,
    hostPathAccess: {
      environmentRootVariables: ['FLUJO_BASH_ROOTS', 'FLUJO_FS_ROOTS'],
      protectedPaths: true,
      snapshots: true,
    },
  },
  {
    defaultName: 'browser',
    packageId: '@mario.andreschak/mcp-browser',
    legacyPackageIds: ['@flujo-ai/mcp-browser'],
    packageDirectory: 'browser',
    icons: [{ src: '/mcp-icons/browser.svg', mimeType: 'image/svg+xml' }],
    enableMcpApps: true,
    disabledByDefault: (env) => !/^(1|true|yes|on)$/i.test(
      env.FLUJO_BROWSER_ENABLED?.trim() ?? '',
    ),
  },
] as const;

export function shippedMcpAppRoot(env: Environment = process.env): string {
  return path.resolve(env.FLUJO_APP_ROOT?.trim() || process.cwd());
}

/** Forward only the operator controls needed by the standalone child process. */
export function shippedServerEnv(
  descriptor: ShippedMcpServerDescriptor,
  env: Environment = process.env,
): Record<string, string> {
  const workspace = getCurrentWorkspace();
  const parentDataDir = path.resolve(env.FLUJO_DATA_DIR?.trim() || process.cwd());
  const workspaceDataDir = path.join(parentDataDir, 'workspaces', workspace);
  const result: Record<string, string> = {
    FLUJO_DATA_DIR: workspaceDataDir,
    FLUJO_WORKSPACE: workspace,
  };
  const forwarded = new Set([
    'FLUJO_BASE_URL',
    'FLUJO_EXTRA_CA_CERTS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'SSL_CERT_FILE',
  ]);

  if (descriptor.defaultName === 'flujo') {
    forwarded.add('FLUJO_SYSTEM_SCREENSHOT_ENABLED');
  } else if (descriptor.defaultName === 'filesystem') {
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
      'FLUJO_BROWSER_MODE',
      'FLUJO_BROWSER_EXECUTABLE_PATH',
      'FLUJO_BROWSER_PROFILE_DIR',
      'FLUJO_BROWSER_LOCALE',
      'FLUJO_BROWSER_TIMEZONE_ID',
      'FLUJO_BROWSER_EXTENSION_DIRS',
      'FLUJO_BROWSER_WINDOW_VISIBILITY',
      'FLUJO_BROWSER_MAX_SESSIONS',
      'FLUJO_BROWSER_IDLE_TIMEOUT_MS',
      'FLUJO_BROWSER_MAX_REDIRECTS',
      'FLUJO_BROWSER_SCREENSHOT_DIR',
      // Live view gateway (MJPEG screencast + input) and media/runtime tuning.
      'FLUJO_BROWSER_STREAM_ENABLED',
      'FLUJO_BROWSER_STREAM_HOST',
      'FLUJO_BROWSER_STREAM_PORT',
      'FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN',
      'FLUJO_BROWSER_STREAM_QUALITY',
      // Escape hatch: relax the live-view gateway origin allowlist for hosted
      // deployments behind a rewriting reverse proxy (see gateway.ts).
      'FLUJO_MCP_APP_SANDBOX_ALLOW_ALL',
      'FLUJO_BROWSER_STREAM_MAX_WIDTH',
      'FLUJO_BROWSER_STREAM_MAX_HEIGHT',
      'FLUJO_BROWSER_STREAM_AUDIO',
      'FLUJO_BROWSER_VIEWPORT_WIDTH',
      'FLUJO_BROWSER_VIEWPORT_HEIGHT',
      'FLUJO_BROWSER_CHANNEL',
      'FLUJO_BROWSER_HEADED',
      'FLUJO_BROWSER_AUDIO',
      'FLUJO_BROWSER_ALLOW_SERVICE_WORKERS',
      'PLAYWRIGHT_BROWSERS_PATH',
      // Deterministic capture (#366): local-source gating, output roots, and
      // the optional recording/muxing pipeline.
      'FLUJO_BROWSER_ALLOW_LOCAL_CAPTURE',
      'FLUJO_BROWSER_LOCAL_CAPTURE_ROOTS',
      'FLUJO_BROWSER_RECORD_DIR',
      'FLUJO_BROWSER_RECORD_MAX_MS',
      'FLUJO_FFMPEG_PATH',
    ]) forwarded.add(key);
  }

  for (const key of forwarded) {
    const value = env[key];
    if (typeof value === 'string') result[key] = value;
  }
  // Inherit-all (bash) and explicit forwarded values must never overwrite the
  // workspace process boundary established above.
  result.FLUJO_DATA_DIR = workspaceDataDir;
  result.FLUJO_WORKSPACE = workspace;
  if (descriptor.defaultName === 'browser') {
    // These are durable outputs. Operator values are useful when the browser
    // package is run standalone, but the FLUJO-managed copy must always keep
    // them in the selected workspace.
    result.FLUJO_BROWSER_PROFILE_DIR = path.join(workspaceDataDir, 'browser-profile', 'trusted');
    result.FLUJO_BROWSER_SCREENSHOT_DIR = path.join(workspaceDataDir, 'screenshots', 'browser');
    result.FLUJO_BROWSER_RECORD_DIR = path.join(workspaceDataDir, 'recordings', 'browser');
  }
  return result;
}

/** Identify a bundled package by immutable install/source identity, not display name. */
export function shippedDescriptorForConfig(config: MCPStdioConfig): ShippedMcpServerDescriptor | undefined {
  const record = config as MCPStdioConfig & { internalPackage?: unknown };
  const sourceId = record.source?.type === 'marketplace' ? record.source.id : undefined;
  return SHIPPED_MCP_SERVERS.find(descriptor => {
    const ids = [descriptor.packageId, ...(descriptor.legacyPackageIds ?? [])];
    return ids.includes(sourceId ?? '') || ids.includes(
      typeof record.internalPackage === 'string' ? record.internalPackage : '',
    );
  });
}

/** Build the ordinary persisted stdio record installed for one shipped package. */
export function createShippedServerConfig(
  descriptor: ShippedMcpServerDescriptor,
  env: Environment = process.env,
): MCPStdioConfig {
  const appRoot = shippedMcpAppRoot(env);
  return {
    name: descriptor.defaultName,
    transport: 'stdio',
    command: 'node',
    args: [path.join(appRoot, 'mcp-servers', descriptor.packageDirectory, 'dist', 'index.js')],
    env: shippedServerEnv(descriptor, env),
    cwd: appRoot,
    disabled: descriptor.disabledByDefault?.(env) ?? false,
    autoApprove: [],
    rootPath: path.join(appRoot, 'mcp-servers', descriptor.packageDirectory),
    roots: [],
    _buildCommand: '',
    _installCommand: '',
    source: { type: 'marketplace', id: descriptor.packageId },
    icons: descriptor.icons,
    exposeAsMcpServer: true,
    enableMcpApps: descriptor.enableMcpApps ?? false,
    ...(descriptor.hostPathAccess
      ? { hostPathAccess: descriptor.hostPathAccess }
      : {}),
  };
}
