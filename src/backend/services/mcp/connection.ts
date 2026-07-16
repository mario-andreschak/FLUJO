import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransportOptions, StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransportOptions, SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { MCPSSEConfig } from '@/shared/types/mcp/mcp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPStdioConfig, MCPStreamableConfig, SERVER_DIR_PREFIX } from '@/shared/types/mcp';
import { ChildProcess } from 'child_process';
import { createOAuthClientProvider } from './oauth';
import { isClientConnectionClosed } from '@/utils/mcp/utils';
import { resolveServerCwd } from '@/utils/mcp/resolveServerCwd';
import { resolveNodeCommand } from '@/utils/mcp/resolveNodeCommand';
import { getDataDir } from '@/utils/paths';
import { registerRootsHandler } from './roots';
import { samplingEnabled, registerSamplingHandler, samplingConfigKey } from './sampling';
import { resolveAndDecryptApiKey } from '@/backend/utils/resolveGlobalVars';
import { normalizeHeaderValue } from '@/utils/mcp/headers';
import { MCPHeaderValue } from '@/shared/types/mcp/mcp';

// We stash a capabilities key on the client so shouldRecreateClient can detect a change to
// a client-declared MCP capability that is negotiated at connect time (the SDK doesn't
// expose a client's own declared capabilities publicly). Roots deliberately do NOT
// participate: the roots capability is always declared and roots content is resolved
// fresh per roots/list request (changes are announced via notifications/roots/
// list_changed) — so no roots change may ever force a client rebuild (issue 46).
interface ClientWithCapKey { __flujoCapKey?: string }

/** Key of the config that drives client-declared capabilities (currently: sampling). */
function capabilityKey(config: MCPServerConfig): string {
  return samplingConfigKey(config);
}

// We stash the RAW config key on the transport at creation time so
// shouldRecreateClient can compare config-to-config (see stdioConfigKey /
// httpConfigKey below). __flujoStdioKey covers stdio; __flujoHttpKey covers the
// streamable/SSE (HTTP) auth material that the URL check alone cannot see.
interface TransportWithConfigKey { __flujoStdioKey?: string; __flujoHttpKey?: string }

const log = createLogger('backend/services/mcp/connection');

/**
 * Flatten + resolve a remote server's custom headers to plain string values for the live
 * connection (#84). Header values may be stored as plain strings (legacy/non-secret),
 * `{ value, metadata }` objects, `encrypted:` secrets, or `${global:VAR}` bindings.
 * `resolveAndDecryptApiKey` handles decryption and global-var resolution for every case
 * (plain values pass through unchanged); values that fail to resolve are dropped.
 *
 * Returns a shallow clone of the config whose `headers` are the resolved plain-string map.
 * The SAME resolved config must feed both createTransport() and shouldRecreateClient() so
 * the httpConfigKey they compute matches (otherwise a bound-global header would force a
 * rebuild on every connect). A changed bound-global therefore still rebuilds the client,
 * because the resolved header material — and thus the key — changes.
 */
export async function resolveConfigHeaders(config: MCPServerConfig): Promise<MCPServerConfig> {
  if (config.transport !== 'streamable' && config.transport !== 'sse') {
    return config;
  }
  const c = config as unknown as { headers?: Record<string, MCPHeaderValue> };
  if (!c.headers || typeof c.headers !== 'object') {
    return config;
  }
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(c.headers)) {
    if (!key) continue;
    const { value } = normalizeHeaderValue(raw, key);
    if (!value) continue;
    const out = await resolveAndDecryptApiKey(value);
    if (out) {
      resolved[key] = out;
    }
  }
  return { ...config, headers: resolved } as MCPServerConfig;
}

/**
 * Flatten stored env vars to plain string values. Env vars may be persisted either as
 * plain strings or as { value, metadata } objects (secrets); spawning and config
 * comparison both need the flat form.
 */
/**
 * Flatten a header map to `Record<string,string>` for the SDK's requestInit, skipping empty
 * keys/values. Values are normally already resolved plain strings (see resolveConfigHeaders);
 * this stays defensive against a residual `{ value, metadata }` object by reading `.value`.
 */
function flattenCustomHeaders(headers: Record<string, MCPHeaderValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    if (!key) continue;
    const { value } = normalizeHeaderValue(raw, key);
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

function transformEnv(env?: Record<string, unknown>): Record<string, string> {
  const transformed: Record<string, string> = {};
  if (env) {
    for (const [key, envVar] of Object.entries(env)) {
      if (envVar && typeof envVar === 'object' && 'value' in envVar) {
        transformed[key] = (envVar as { value: string }).value;
      } else {
        transformed[key] = envVar as string;
      }
    }
  }
  return transformed;
}

/**
 * Identity key of everything in a stdio config that affects the spawned process.
 *
 * The spawn pipeline REWRITES the configured command/args (.bat -> `cmd.exe /c`, bare
 * `node`/`npm`/`npx` -> absolute path — see createStdioTransport), so the transport's
 * final _serverParams can never be compared against the raw config: for a config with
 * command "node" that comparison was ALWAYS unequal, making shouldRecreateClient report
 * "parameters changed" for a byte-identical config. Every connectServer() call on a live
 * client then tore down and respawned a perfectly healthy server — the engine of the
 * restart death-spiral. So the transport is keyed with the RAW config at creation time
 * and compared raw-to-raw here.
 */
function stdioConfigKey(config: MCPStdioConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: transformEnv(config.env),
    cwd: String(config.cwd ?? ''),
    rootPath: config.rootPath ?? '',
  });
}

/**
 * Identity key of everything in a streamable/SSE (HTTP) config that affects the live
 * connection but is NOT the URL — chiefly the auth material (Authorization / custom
 * headers, requestInit, OAuth client + tokens) and session / reconnection options.
 *
 * shouldRecreateClient otherwise compared ONLY the URL for HTTP transports, so updating
 * a server's PAT / Bearer token (same URL) was not detected: connectServer short-circuited
 * as "already connected" and kept talking to the stale-token client. That is exactly why a
 * PAT update verified fine in the Tool Tester / a manual chat run (fresh client in the
 * acting instance) yet the planned execution still failed with `unauthorized`. The
 * transport is keyed with these fields at creation time and compared raw-to-raw here.
 */
function httpConfigKey(config: MCPServerConfig): string {
  // MCPStreamableConfig & MCPSSEConfig intersects to `never` (their `transport` literals
  // conflict), so read the shared HTTP fields off an explicit optional shape instead.
  const c = config as unknown as {
    serverUrl?: string;
    headers?: Record<string, string>;
    requestInit?: unknown;
    eventSourceInit?: unknown;
    reconnectionOptions?: unknown;
    sessionId?: string;
    oauthClientId?: string;
    oauthClientInformation?: unknown;
    oauthClientSecret?: string;
    oauthTokens?: unknown;
  };
  return JSON.stringify({
    transport: config.transport,
    url: c.serverUrl ?? '',
    headers: c.headers ?? {},
    requestInit: c.requestInit ?? {},
    eventSourceInit: c.eventSourceInit ?? {},
    reconnectionOptions: c.reconnectionOptions ?? {},
    sessionId: c.sessionId ?? '',
    oauthClientId: c.oauthClientId ?? '',
    oauthClientInformation: c.oauthClientInformation ?? {},
    oauthClientSecret: c.oauthClientSecret ?? '',
    oauthTokens: c.oauthTokens ?? {},
  });
}

/**
 * Create a new MCP client with proper capabilities
 */
export function createNewClient(config: MCPServerConfig): Client {
  log.debug('Entering createNewClient method');

  // CLIENT capabilities advertise what FLUJO (as the MCP client) offers to the server —
  // e.g. roots/sampling/elicitation. tools/resources/prompts are SERVER capabilities and
  // are consumed regardless of what we declare here, so they do not belong here.
  //
  // Roots (#15/#46) are ALWAYS declared — the spec makes roots a client capability
  // independent of how many roots exist, and roots/list defaults to the server's own
  // rootPath when the user configured none (see roots.ts). Keeping the declaration
  // unconditional means roots changes never require a client rebuild; content changes
  // are announced via notifications/roots/list_changed instead. Sampling stays opt-in:
  // it is declared only when the server has an enabled sampling trust policy, so a
  // server can't ask FLUJO to run LLM calls unless the user opted in.
  const serverHasSampling = samplingEnabled(config);
  const client = new Client(
    {
      name: `flujo-${config.name}-client`,
      version: '3.19.0',
    },
    {
      capabilities: {
        experimental: {},
        roots: { listChanged: true },
        ...(serverHasSampling ? { sampling: {} } : {}),
      }
    }
  );

  registerRootsHandler(client, config);
  if (serverHasSampling) {
    registerSamplingHandler(client, config);
  }
  (client as unknown as ClientWithCapKey).__flujoCapKey = capabilityKey(config);

  return client;
}

/**
 * Create a transport for the MCP client
 */
export function createTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
  log.debug('Entering createTransport method');

  if (config.transport === 'streamable') {
    log.info(`Creating streamable http transport for server ${config.name} with URL ${config.serverUrl}`);
    const streamableConfig = config as MCPStreamableConfig;
    
    // Create transport options.
    // Build defensively: only include object-typed options when they are actual objects.
    // Legacy persisted configs may contain empty strings (''), which would be spread into
    // the SDK's internal fetch() call and cause a generic "fetch failed" error.
    const transportoptions: StreamableHTTPClientTransportOptions = {};

    if (streamableConfig.requestInit && typeof streamableConfig.requestInit === 'object') {
      transportoptions.requestInit = streamableConfig.requestInit;
    }
    if (streamableConfig.reconnectionOptions && typeof streamableConfig.reconnectionOptions === 'object') {
      transportoptions.reconnectionOptions = streamableConfig.reconnectionOptions;
    }
    if (typeof streamableConfig.sessionId === 'string' && streamableConfig.sessionId.length > 0) {
      transportoptions.sessionId = streamableConfig.sessionId;
    }

    // Merge user-defined custom headers (e.g. Authorization, X-SAP-System-Id, X-SAP-Client)
    // into requestInit so they are sent on every request the SDK makes. Headers are expected
    // to have been resolved to plain strings by resolveConfigHeaders() before this point;
    // flattenCustomHeaders is defensive against any residual { value, metadata } shape.
    if (streamableConfig.headers && typeof streamableConfig.headers === 'object') {
      const customHeaders = flattenCustomHeaders(streamableConfig.headers);
      if (Object.keys(customHeaders).length > 0) {
        transportoptions.requestInit = {
          ...(transportoptions.requestInit || {}),
          headers: {
            ...((transportoptions.requestInit?.headers as Record<string, string>) || {}),
            ...customHeaders,
          },
        };
        log.info(`Applied ${Object.keys(customHeaders).length} custom header(s) for ${config.name}: ${Object.keys(customHeaders).join(', ')}`);
      }
    }

    // Add OAuth authentication if configured
    if (streamableConfig.oauthClientId || streamableConfig.oauthClientInformation) {
      log.info(`Setting up OAuth authentication for ${config.name}`);
      const oauthProvider = createOAuthClientProvider(streamableConfig);
      
      // Always set the OAuth provider - let the transport handle the OAuth flow
      transportoptions.authProvider = oauthProvider;
      
      // Check if we have stored tokens, for logging purposes only - actual freshness/expiry
      // is resolved async by oauthProvider.tokens() when the transport uses it.
      if (streamableConfig.oauthTokens?.access_token) {
        log.debug(`OAuth provider configured for ${config.name} with existing tokens`);
        log.debug(`Token expires in: ${streamableConfig.oauthTokens.expires_in} seconds`);
      } else {
        log.debug(`OAuth provider configured for ${config.name} - will initiate OAuth flow if needed`);
      }
    } else {
      log.debug(`No OAuth configuration found for ${config.name}`);
    }
    
    const transport = new StreamableHTTPClientTransport(new URL(config.serverUrl), transportoptions);
    // Key the transport with the RAW auth/session material so shouldRecreateClient can
    // detect a PAT / Bearer token / header change even when the URL is unchanged.
    (transport as unknown as TransportWithConfigKey).__flujoHttpKey = httpConfigKey(config);
    return transport;

  } else if (config.transport === 'sse') {
    log.info(`Creating legacy sse transport for server ${config.name} with URL ${config.serverUrl}`);
    const sseConfig = config as MCPSSEConfig;

    // Build options defensively. Do NOT spread the entire config: it contains many
    // unrelated fields (and possibly empty-string options from legacy persisted data)
    // that would corrupt the SDK's internal fetch() call and cause "fetch failed".
    const transportoptions: SSEClientTransportOptions = {};

    if (sseConfig.requestInit && typeof sseConfig.requestInit === 'object') {
      transportoptions.requestInit = sseConfig.requestInit;
    }
    if (sseConfig.eventSourceInit && typeof sseConfig.eventSourceInit === 'object') {
      transportoptions.eventSourceInit = sseConfig.eventSourceInit;
    }

    // Merge user-defined custom headers (e.g. Authorization, X-SAP-System-Id, X-SAP-Client)
    // into requestInit so they are sent on every request the SDK makes. Headers are expected
    // to have been resolved to plain strings by resolveConfigHeaders() before this point;
    // flattenCustomHeaders is defensive against any residual { value, metadata } shape.
    if (sseConfig.headers && typeof sseConfig.headers === 'object') {
      const customHeaders = flattenCustomHeaders(sseConfig.headers);
      if (Object.keys(customHeaders).length > 0) {
        transportoptions.requestInit = {
          ...(transportoptions.requestInit || {}),
          headers: {
            ...((transportoptions.requestInit?.headers as Record<string, string>) || {}),
            ...customHeaders,
          },
        };
        log.info(`Applied ${Object.keys(customHeaders).length} custom header(s) for ${config.name}: ${Object.keys(customHeaders).join(', ')}`);
      }
    }

    const transport = new SSEClientTransport(new URL(config.serverUrl), transportoptions);
    // Key the transport with the RAW auth/session material so shouldRecreateClient can
    // detect a PAT / Bearer token / header change even when the URL is unchanged.
    (transport as unknown as TransportWithConfigKey).__flujoHttpKey = httpConfigKey(config);
    return transport;

  } else if (config.transport === 'websocket') {
    log.info(`Creating WebSocket transport for server ${config.name} with URL ${config.websocketUrl}`);
    return new WebSocketClientTransport(new URL(config.websocketUrl));

  } else {
    return createStdioTransport(config);
  }
}

/**
 * Create a stdio transport for the MCP client
 */
export function createStdioTransport(config: MCPServerConfig): StdioClientTransport {
  log.debug('Entering createStdioTransport method');
  
  // Ensure we're working with a stdio config
  if (config.transport !== 'stdio') {
    throw new Error('Cannot create stdio transport for non-stdio config');
  }
  
  // For Windows .bat files, we need to use cmd.exe to execute them
  let command = config.command;
  let args = config.args ? [...config.args] : [];
  const serverDir = `${SERVER_DIR_PREFIX}/${config.name}`;

  log.info(`Creating stdio transport for server ${config.name}`);
  log.debug(`Original command: ${command}`);
  log.debug(`Original args: ${JSON.stringify(args)}`);
  log.debug(`Server directory: ${serverDir}`);

  // Check if the command is a relative path or just a filename
  const isRelativePath = !path.isAbsolute(command) &&
    (command.includes('/') || command.includes('\\'));
  const isJustFilename = !command.includes('/') && !command.includes('\\');

  // Log the path analysis
  log.debug(`Is relative path: ${isRelativePath}`);
  log.debug(`Is just filename: ${isJustFilename}`);

  // Check if this is a .bat file on Windows
  if (os.platform() === 'win32' && command.toLowerCase().endsWith('.bat')) {
    log.debug(`Detected .bat file on Windows: ${command}`);

    // If it's just a filename (e.g., "run.bat"), check if it exists in the server directory
    if (isJustFilename) {
      const fullPath = path.join(getDataDir(), serverDir, command);
      log.debug(`Checking if file exists at: ${fullPath}`);

      const fileExists = fs.existsSync(fullPath);
      log.debug(`File exists: ${fileExists}`);

      if (fileExists) {
        // Use the full path to the .bat file
        log.debug(`Using full path to .bat file: ${fullPath}`);
        // Use cmd.exe to execute the .bat file
        args = ['/c', fullPath, ...args];
        command = 'cmd.exe';
      } else {
        log.warn(`WARNING: .bat file not found at ${fullPath}`);
        // Still try to use cmd.exe, but log the warning
        args = ['/c', command, ...args];
        command = 'cmd.exe';
      }
    } else {
      // For relative or absolute paths, use as is with cmd.exe
      log.debug(`Using cmd.exe with path as provided: ${command}`);
      args = ['/c', command, ...args];
      command = 'cmd.exe';
    }
  }

  // #36: resolve bare `node`/`npm`/`npx` to absolute paths so spawning works even
  // when FLUJO was launched outside a shell that initialized nvm (and thus inherited
  // a PATH without the nvm Node bin dir). Runs after the .bat rewrite above so
  // `cmd.exe` is left untouched.
  const resolvedCommand = resolveNodeCommand(command, {
    execPath: process.execPath,
    platform: os.platform(),
    dirname: path.dirname,
    joinPath: path.join,
    fileExists: fs.existsSync,
  });
  if (resolvedCommand !== command) {
    log.debug(`Resolved Node toolchain command "${command}" to absolute path: ${resolvedCommand}`);
    command = resolvedCommand;
  }

  log.debug(`Final command: ${command}`);
  log.debug(`Final args: ${JSON.stringify(args)}`);
  // Use the original (pre-.bat-rewrite) command/args for runner detection so e.g.
  // `npx` isn't masked by the cmd.exe wrapper applied above for .bat files.
  const resolvedCwd = resolveServerCwd({
    command: config.command,
    args: config.args,
    rootPath: config.rootPath,
    cwd: config.cwd,
    serverName: config.name,
    defaultCwd: `${SERVER_DIR_PREFIX}/${config.name}`,
  });
  // resolveServerCwd may hand back a relative path (e.g. the default
  // `mcp-servers/<name>`). A child process resolves a relative cwd against the
  // FLUJO process's cwd (the app dir), but mcp-servers/ lives under the DATA dir
  // for a packaged install — so anchor a relative cwd to the data dir. For a git
  // checkout the data dir IS the app dir, so this is a no-op there.
  const cwd = path.isAbsolute(resolvedCwd)
    ? resolvedCwd
    : path.join(getDataDir(), resolvedCwd);
  log.debug(`cwd: ${cwd}`);
  log.debug(`env: ${JSON.stringify(config.env)}`);

  // Create the transport with stderr capture
  log.info(`Creating StdioClientTransport for ${config.name} with stderr: 'pipe'`);

  // Transform the env object to extract only the value part from each key
  const transformedEnv = transformEnv(config.env);

  log.verbose('Transformed environment variables', JSON.stringify(transformedEnv));
  const transportoptions: StdioServerParameters = {
    command: command, 
    args: args,
    env: transformedEnv,
    cwd: cwd, 
    stderr: 'pipe'
  };

  const transport = new StdioClientTransport(transportoptions);

  // Key the transport with the RAW config so shouldRecreateClient can tell whether a
  // later config is byte-identical, independent of the command/args rewrites above.
  (transport as unknown as TransportWithConfigKey).__flujoStdioKey = stdioConfigKey(config);

  // Check if stderr is available
  if (transport.stderr) {
    log.info(`Stderr stream is available for ${config.name}`);
  } else {
    log.warn(`Stderr stream is NOT available for ${config.name}`);
  }

  return transport;
}

/**
 * Check if an existing client needs to be recreated
 */
export function shouldRecreateClient(
  client: Client,
  config: MCPServerConfig
): { needsNewClient: boolean; reason?: string } {
  log.debug('Entering shouldRecreateClient method');

  // A closed connection can never serve another request — for HTTP transports the
  // aborted internal signal makes every send() reject instantly with AbortError
  // ("This operation was aborted"). connectServer would otherwise short-circuit on
  // the map entry as "already connected" and hand the corpse back to the caller.
  // This is a LIVENESS fact, not a config change, so it cannot re-trigger the
  // restart death-spiral this function's raw-key comparisons guard against: a
  // healthy connection never reads as closed.
  if (isClientConnectionClosed(client)) {
    return { needsNewClient: true, reason: 'Existing connection is closed' };
  }

  // A change to a connect-time-negotiated client capability (sampling) must rebuild the
  // client: it alters both the declared capability (none<->some) and the config the
  // request handlers close over. Roots are exempt by design (issue 46): the capability
  // is always declared and content changes are served live by the roots/list handler +
  // announced via notifications/roots/list_changed — never a rebuild.
  const currentCapKey = (client as unknown as ClientWithCapKey).__flujoCapKey ?? '';
  if (currentCapKey !== capabilityKey(config)) {
    return { needsNewClient: true, reason: 'Client capabilities (sampling) changed' };
  }

  // Check if transport type has changed
  if (config.transport === 'websocket') {
    if (!(client.transport instanceof WebSocketClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to websocket',
      };
    }

    // // For WebSocket, check if URL has changed
    // const transport = client.transport as WebSocketClientTransport;
    // if (transport._url?.toString() !== config.websocketUrl) { // Property '_url' is private and only accessible within class 'WebSocketClientTransport'.
    //   return { needsNewClient: true, reason: 'WebSocket URL changed' };
    // }
  } else if (config.transport === 'streamable') {
    // For streamable HTTP transport, ensure the existing client uses the matching transport.
    if (!(client.transport instanceof StreamableHTTPClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to streamable',
      };
    }

    // Check if the server URL has changed
    const transport = client.transport as StreamableHTTPClientTransport;
    const currentUrl = (transport as unknown as { _url?: URL })._url?.toString();
    if (currentUrl !== undefined && currentUrl !== new URL(config.serverUrl).toString()) {
      return { needsNewClient: true, reason: 'Streamable server URL changed' };
    }

    // The URL alone cannot reveal a changed PAT / Bearer token or custom header (same URL,
    // new auth). Compare the RAW auth/session key stashed at creation so a token update
    // rebuilds the client instead of silently reusing the stale-token connection — the
    // direct cause of the planned execution's `unauthorized` after a PAT update.
    const existingHttpKey = (transport as unknown as TransportWithConfigKey).__flujoHttpKey;
    if (!existingHttpKey) {
      return { needsNewClient: true, reason: 'Existing streamable transport has no config key' };
    }
    if (existingHttpKey !== httpConfigKey(config)) {
      return { needsNewClient: true, reason: 'Streamable auth/connection parameters changed' };
    }
  } else if (config.transport === 'sse') {
    // For SSE transport, ensure the existing client uses the matching transport.
    if (!(client.transport instanceof SSEClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to sse',
      };
    }

    // Check if the server URL has changed
    const sseConfig = config as MCPSSEConfig;
    const transport = client.transport as SSEClientTransport;
    const currentUrl = (transport as unknown as { _url?: URL })._url?.toString();
    if (currentUrl !== undefined && currentUrl !== new URL(sseConfig.serverUrl).toString()) {
      return { needsNewClient: true, reason: 'SSE server URL changed' };
    }

    // Same as streamable: detect a changed PAT / Bearer token or custom header behind an
    // unchanged URL by comparing the RAW auth/session key stashed at creation time.
    const existingHttpKey = (transport as unknown as TransportWithConfigKey).__flujoHttpKey;
    if (!existingHttpKey) {
      return { needsNewClient: true, reason: 'Existing sse transport has no config key' };
    }
    if (existingHttpKey !== httpConfigKey(config)) {
      return { needsNewClient: true, reason: 'SSE auth/connection parameters changed' };
    }
  } else {
    // Default is stdio transport
    if (!(client.transport instanceof StdioClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to stdio',
      };
    }

    // Ensure we're working with a stdio config
    if (config.transport !== 'stdio') {
      return { needsNewClient: true, reason: 'Transport type changed from stdio' };
    }

    // Compare the RAW config the transport was created from against the incoming raw
    // config. Comparing against the transport's _serverParams is wrong: those hold the
    // REWRITTEN command/args (.bat -> cmd.exe, bare node -> absolute path), so for e.g.
    // command "node" they never matched the raw config and every reconnect attempt
    // needlessly killed and respawned a healthy server (the restart death-spiral).
    const existingKey = (client.transport as unknown as TransportWithConfigKey).__flujoStdioKey;
    if (!existingKey) {
      // Transport predates the config-key mechanism (only possible for a client adopted
      // across a dev hot-reload via the global recovery map) — we cannot prove the
      // config still matches, so rebuild once to get a keyed transport.
      return { needsNewClient: true, reason: 'Existing stdio transport has no config key' };
    }

    if (existingKey !== stdioConfigKey(config)) {
      return {
        needsNewClient: true,
        reason: 'Connection parameters changed',
      };
    }
  }

  return { needsNewClient: false };
}

/**
 * Wait for a child process to exit, up to timeoutMs.
 * Resolves true if the process exited (or had already exited), false on timeout.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

export interface SafeCloseOptions {
  /** How long to wait for the child to exit after stdin is closed (graceful window). */
  gracePeriodMs?: number;
  /** After SIGTERM, how long to wait before escalating to SIGKILL. */
  killEscalationMs?: number;
}

/**
 * Safely close a client connection following the MCP shutdown sequence.
 *
 * For stdio transports the graceful path is closing stdin and WAITING for the child to
 * exit on its own BEFORE calling client.close(). Order matters: the SDK's
 * StdioClientTransport.close() has a hardcoded stdin -> 2s -> SIGTERM -> 2s -> SIGKILL
 * ladder, and on Windows SIGTERM is TerminateProcess (no handlers run), so calling
 * close() while the child is still shutting down hard-kills it mid-teardown and orphans
 * its own children (e.g. a puppeteer browser holding a profile lock). Servers with real
 * teardown work (browser destroy, session flush) legitimately need more than 2s.
 * Once the child has exited, the SDK's ladder is a no-op.
 */
export async function safelyCloseClient(client: Client, serverName: string, config?: MCPServerConfig, options?: SafeCloseOptions): Promise<void> {
  log.debug('Entering safelyCloseClient method');
  const gracePeriodMs = options?.gracePeriodMs ?? 15000;
  const killEscalationMs = options?.killEscalationMs ?? 5000;
  try {
    // Check if the transport is stdio
    if (client.transport instanceof StdioClientTransport) {
      const stdioTransport = client.transport as StdioClientTransport;
      const child: ChildProcess | undefined = (stdioTransport as unknown as { _process: ChildProcess | undefined })._process;

      if (child && child.exitCode === null && child.signalCode === null) {
        // First close stdin to signal graceful shutdown (the MCP stdio convention)
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
            log.debug(`Closed stdin for graceful shutdown for ${serverName}`);
          }
        } catch (stdinError) {
          log.warn(`Error closing stdin for ${serverName}:`, stdinError);
        }

        let exited = await waitForExit(child, gracePeriodMs);

        if (!exited) {
          log.warn(`Process did not exit within ${gracePeriodMs}ms after stdin close, sending SIGTERM for ${serverName}`);
          try {
            child.kill('SIGTERM');
          } catch (termError) {
            log.error(`Error sending SIGTERM for ${serverName}:`, termError);
          }
          // On Windows SIGTERM is already TerminateProcess, so this second wait
          // resolves almost immediately; on POSIX it gives handlers a chance.
          exited = await waitForExit(child, killEscalationMs);
        }

        if (!exited) {
          log.warn(`Process did not respond to SIGTERM, sending SIGKILL for ${serverName}`);
          try {
            child.kill('SIGKILL');
          } catch (killError) {
            log.error(`Error sending SIGKILL for ${serverName}:`, killError);
          }
        } else {
          log.info(`Process exited gracefully for ${serverName}`);
        }
      }
    }

    // Close the client. For stdio the child has already exited (or been killed) at this
    // point, so the SDK's internal kill ladder cannot land mid-teardown.
    await client.close();
    log.info(`Client closed successfully for ${serverName}`);
  } catch (error) {
    log.warn(`Error closing client for ${serverName}:`, error);
    // We continue even if close fails
  }
}
