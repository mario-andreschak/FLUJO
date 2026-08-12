import path from 'path';
import simpleGit from 'simple-git';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPServerSource, MCPStdioConfig, MCPWebSocketConfig, MCPServiceResponse, MCPSSEConfig, MCPStreamableConfig } from '@/shared/types/mcp';
import { getWorkspaceDataDir, remapLegacyDefaultWorkspaceReference } from '@/utils/workspace';

const log = createLogger('backend/services/mcp/config');

// Transports that connect to a hosted endpoint (no local process). Their rootPath is
// only used by FLUJO's own file/git features (folder pickers, ServerCard actions,
// git-update route), so a filesystem-root value is never a sensible scope.
const REMOTE_TRANSPORTS = new Set(['streamable', 'sse', 'websocket']);

// Where GitHub/reference server clones live (mirrors /api/git's REPOS_BASE_DIR).
// Used to decide whether an un-sourced server's rootPath is a git clone whose
// origin can be read to reconstruct a `github` install-origin (#193 backfill).
// Per-call, not a module constant: mcp-servers/ lives inside the SELECTED
// workspace (#406), so the same server name can exist independently in two
// workspaces and a captured constant would cross-wire them.
const reposBaseDir = () => path.join(getWorkspaceDataDir(), 'mcp-servers');

// Per-process memo of read-time git-remote lookups (keyed by absolute repo path),
// so the backfill spawns `git remote get-url origin` at most once per clone even
// though loadServerConfigs is called frequently (server-list polling). Null means
// "looked, none found" and is cached too, so failures don't retry every load.
const gitRemoteCache = new Map<string, string | null>();

/** Resolve a (possibly relative) server rootPath to an absolute path under the data dir. */
function resolveRootPath(rootPath: unknown): string | null {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') return null;
  // Absolute roots are explicit operator choices and stay exactly as configured
  // (they may deliberately point outside FLUJO); relative roots are
  // workspace-relative.
  return path.isAbsolute(rootPath) ? rootPath : path.resolve(getWorkspaceDataDir(), rootPath);
}

/** Is this absolute path inside the mcp-servers clone directory? */
function isInsideReposDir(absPath: string): boolean {
  const rel = path.relative(reposBaseDir(), absPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Best-effort read of a clone's `origin` remote URL. Bounded (5s) and never
 * throws: a slow/failing git call falls back to null so config load is never
 * blocked or broken. Result is memoized per absolute path.
 */
async function readGitRemote(absPath: string): Promise<string | null> {
  if (gitRemoteCache.has(absPath)) return gitRemoteCache.get(absPath)!;
  let url: string | null = null;
  try {
    const git = simpleGit({ baseDir: absPath, timeout: { block: 5000 } });
    const raw = (await git.remote(['get-url', 'origin'])) || '';
    url = raw.trim() || null;
  } catch {
    url = null;
  }
  gitRemoteCache.set(absPath, url);
  return url;
}

/**
 * Infer an install-origin for a server that has none persisted (#193 backfill).
 * Remote transports are `remote`; a stdio/websocket server whose rootPath is a
 * git clone under mcp-servers/ becomes `github` (from its origin remote); every
 * other local server is `local`. Best-effort and idempotent.
 */
async function inferServerSource(config: MCPServerConfig): Promise<MCPServerSource> {
  if (REMOTE_TRANSPORTS.has(config.transport)) {
    return { type: 'remote' };
  }
  const abs = resolveRootPath(config.rootPath);
  if (abs && isInsideReposDir(abs)) {
    const remoteUrl = await readGitRemote(abs);
    if (remoteUrl) return { type: 'github', repositoryUrl: remoteUrl };
  }
  return { type: 'local' };
}

/**
 * Is this rootPath a bare filesystem root ('/', '\', or a drive root like 'C:\')?
 * Remote server configs created before issue 52 defaulted to '/', which silently
 * pointed folder pickers and git actions at the filesystem root.
 */
function isFilesystemRootPath(rootPath: unknown): boolean {
  if (typeof rootPath !== 'string') return false;
  const trimmed = rootPath.trim();
  return trimmed === '/' || trimmed === '\\' || /^[A-Za-z]:[\\/]?$/.test(trimmed);
}

/**
 * Load MCP server configurations from storage
 */
export async function loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
  log.debug('Entering loadServerConfigs method');
  try {
    const mcpServers = await loadItem<Record<string, any>>(StorageKey.MCP_SERVERS, {});
    
    const configs = Object.entries(mcpServers).map(([name, serverConfig]) => {
      // Determine the transport type
      const transport = serverConfig.transport || 'stdio';

      // Layout-v2 compatibility: old GitHub installs persisted absolute paths
      // into the legacy managed MCP root. Normalize them in memory after the
      // clone has moved; never rewrite an explicit path that still exists.
      const remapMcpPath = (value: unknown): unknown =>
        typeof value === 'string'
          ? remapLegacyDefaultWorkspaceReference(value, 'mcp-servers')
          : value;
      const remapMcpEnv = (record: unknown): unknown => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        return Object.fromEntries(Object.entries(record).map(([key, value]) => {
          if (typeof value === 'string') return [key, remapMcpPath(value)];
          if (value && typeof value === 'object' && typeof value.value === 'string') {
            return [key, { ...value, value: remapMcpPath(value.value) }];
          }
          return [key, value];
        }));
      };
      serverConfig = {
        ...serverConfig,
        rootPath: remapMcpPath(serverConfig.rootPath),
        cwd: remapMcpPath(serverConfig.cwd),
        command: remapMcpPath(serverConfig.command),
        args: Array.isArray(serverConfig.args)
          ? serverConfig.args.map(remapMcpPath)
          : serverConfig.args,
        roots: Array.isArray(serverConfig.roots)
          ? serverConfig.roots.map(remapMcpPath)
          : serverConfig.roots,
        env: remapMcpEnv(serverConfig.env),
        ...(Object.prototype.hasOwnProperty.call(serverConfig, 'launch')
          ? {
              launch: serverConfig.launch && typeof serverConfig.launch === 'object'
                ? {
                    ...serverConfig.launch,
                    command: remapMcpPath(serverConfig.launch.command),
                    cwd: remapMcpPath(serverConfig.launch.cwd),
                    args: Array.isArray(serverConfig.launch.args)
                      ? serverConfig.launch.args.map(remapMcpPath)
                      : serverConfig.launch.args,
                    env: remapMcpEnv(serverConfig.launch.env),
                  }
                : serverConfig.launch,
            }
          : {}),
      };

      // Read-time normalization (issue 52): remote servers saved with a too-wide
      // rootPath default ('/'/drive root) are re-pointed at their per-server folder,
      // matching the stdio convention. Idempotent, not persisted back to storage;
      // deliberately narrow so a user's custom rootPath is never touched.
      if (REMOTE_TRANSPORTS.has(transport) && isFilesystemRootPath(serverConfig.rootPath)) {
        log.info(`Normalizing filesystem-root rootPath "${serverConfig.rootPath}" of remote server ${name} to mcp-servers/${name}`);
        serverConfig = { ...serverConfig, rootPath: `mcp-servers/${name}` };
      }

      // Registry package configs historically used ".", which now means the
      // complete selected workspace and made every npx/uvx server share one root.
      // Migrate only sourced package configs so an operator's explicit local "."
      // remains untouched. Like the remote normalization above, this is in-memory
      // and becomes durable the next time the config is saved.
      const sourceType = serverConfig.source?.type;
      if (
        transport === 'stdio'
        && typeof serverConfig.rootPath === 'string'
        && serverConfig.rootPath.trim() === '.'
        && (sourceType === 'registry' || sourceType === 'marketplace')
        && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
      ) {
        log.info(`Normalizing shared Registry rootPath "." of ${name} to mcp-servers/${name}`);
        serverConfig = { ...serverConfig, rootPath: `mcp-servers/${name}` };
      }
      
      // Default values for any missing properties
      const defaults = {
        name,
        disabled: false,
        rootPath: '',
        env: {},
        _buildCommand: '',
        _installCommand: ''
      };
      
      if (transport === 'streamable') {
        // Create streamable config with defaults.
        // IMPORTANT: Do NOT default object-typed transport options (requestInit,
        // reconnectionOptions, sessionId, authProvider) to empty strings. The MCP SDK
        // expects these to be proper objects (or undefined). Empty strings get spread
        // into the internal fetch() call and cause a generic "fetch failed" error.
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          // Only carry these through if they are actually present; otherwise leave undefined
          requestInit: serverConfig.requestInit && typeof serverConfig.requestInit === 'object'
            ? serverConfig.requestInit
            : undefined,
          reconnectionOptions: serverConfig.reconnectionOptions && typeof serverConfig.reconnectionOptions === 'object'
            ? serverConfig.reconnectionOptions
            : undefined,
          sessionId: serverConfig.sessionId || undefined,
          // OAuth configuration fields
          oauthClientId: serverConfig.oauthClientId || '',
          oauthClientSecret: serverConfig.oauthClientSecret || '',
          oauthScopes: serverConfig.oauthScopes || (serverConfig.oauthClientId || serverConfig.oauthClientInformation ? ['read'] : undefined),
          // Stored OAuth data
          oauthClientMetadata: serverConfig.oauthClientMetadata,
          oauthClientInformation: serverConfig.oauthClientInformation,
          oauthTokens: serverConfig.oauthTokens,
          oauthCodeVerifier: serverConfig.oauthCodeVerifier
        } as MCPStreamableConfig;


      } else if (transport === 'sse') {
        // Create sse config with defaults.
        // Same as streamable: object-typed options must not default to empty strings.
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          eventSourceInit: serverConfig.eventSourceInit && typeof serverConfig.eventSourceInit === 'object'
            ? serverConfig.eventSourceInit
            : undefined,
          requestInit: serverConfig.requestInit && typeof serverConfig.requestInit === 'object'
            ? serverConfig.requestInit
            : undefined
        } as MCPSSEConfig;


      } else if (transport === 'websocket') {
        // Create WebSocket config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          websocketUrl: serverConfig.websocketUrl || ''
        } as MCPWebSocketConfig;


      } else {
        // Create Stdio config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          command: serverConfig.command || '',
          args: serverConfig.args || [],
          stderr: serverConfig.stderr || 'pipe'
        } as MCPStdioConfig;
      }
    });

    // Install-origin backfill (#193): any config that predates the `source` field
    // gets a best-effort origin inferred at read time. Computed-on-load (not
    // force-persisted here) — it durably persists the next time the config is
    // saved. Resilient: inferServerSource never throws and each git lookup is
    // bounded + memoized, so this can't block or break config load.
    await Promise.all(
      configs.map(async (config) => {
        if (!config.source) {
          config.source = await inferServerSource(config);
        }
      })
    );

    return configs;
  } catch (error) {
    log.warn('Failed to load server configs', error);
    return {
      success: false,
      error: `Failed to load server configs: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/** Load the persisted roots for one ordinary server record. */
export async function loadServerRoots(serverName: string): Promise<string[]> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) return [];
  const roots = configs.find((config) => config.name === serverName)?.roots;
  return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string') : [];
}

/**
 * Keys `loadServerConfigs()` materialises as an empty placeholder when the
 * stored record does not have them. Writing those placeholders back would make
 * every load → save cycle grow the stored JSON with phantom keys, so an empty
 * value is persisted as "absent" — exactly how it was read (#392). Load re-adds
 * the same empty default, so this is lossless.
 */
const EMPTY_IS_ABSENT_KEYS = [
  '_buildCommand',
  '_installCommand',
  'oauthClientId',
  'oauthClientSecret'
] as const;

/**
 * Storage form of one config: no `name` (it is the record key), no `undefined`
 * values, and no empty load-time placeholders. Keeps save(load(x)) === x, which
 * matters for additive optional fields such as `launch` (#392) and for diffing
 * `db/mcp_servers.json`.
 */
function toStoredConfig(config: MCPServerConfig): Record<string, unknown> {
  // Remove the name property since it is represented by the storage key.
  // Every server, including shipped package installs, uses this same path.
  const { name: _, ...configWithoutName } = config;
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configWithoutName)) {
    if (value === undefined) continue;
    if (value === '' && (EMPTY_IS_ABSENT_KEYS as readonly string[]).includes(key)) continue;
    stored[key] = value;
  }
  return stored;
}

/**
 * Save MCP server configurations to storage
 */
export async function saveConfig(configs: Map<string, MCPServerConfig>): Promise<MCPServiceResponse> {
  log.debug('Entering saveConfig method');
  try {
    const mcpServers = Object.fromEntries(
      // Return each entry with the server name as the key
      Array.from(configs.entries()).map(([name, config]) => [name, toStoredConfig(config)])
    );

    await saveItem(StorageKey.MCP_SERVERS, mcpServers);
    return { success: true };
  } catch (error) {
    log.warn('Failed to save config', error);
    return {
      success: false,
      error: `Failed to save config: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}
