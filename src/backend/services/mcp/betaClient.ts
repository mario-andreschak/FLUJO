import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  Client as BetaClient,
  StreamableHTTPClientTransport as BetaStreamableHTTPClientTransport,
  SSEClientTransport as BetaSSEClientTransport,
  type StreamableHTTPClientTransportOptions as BetaStreamableOptions,
  type SSEClientTransportOptions as BetaSseOptions,
  type OAuthClientProvider as BetaOAuthClientProvider,
} from "@modelcontextprotocol/client";
import { StdioClientTransport as BetaStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createLogger } from "@/utils/logger";
import { loadItem } from "@/utils/storage/backend";
import { StorageKey } from "@/shared/types/storage";
import { Settings } from "@/shared/types/storage/storage";
import { MCPServerConfig, MCPStreamableConfig } from "@/shared/types/mcp";
import { MCPSSEConfig, MCPHeaderValue } from "@/shared/types/mcp/mcp";
import {
  flattenCustomHeaders,
  httpConfigKey,
  resolveStdioLaunch,
  stdioConfigKey,
  capabilityKey,
  ClientWithBetaMarker,
  TransportWithConfigKey,
} from "./connection";
import { createOAuthClientProvider } from "./oauth";
import { createRootsListHandler } from "./roots";
import { samplingEnabled, createSamplingHandler } from "./sampling";
import { elicitationEnabled, createElicitationHandler } from "./elicitation";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "./appsProtocol";
import {
  STDIO_OAUTH_EXTENSION_CAPABILITY,
  STDIO_OAUTH_EXTENSION_ID,
} from "mcp-stdio-oauth/protocol";
import type { StdioOAuthMrtrController } from "mcp-stdio-oauth/client";
import { StdioOAuthDeferredMrtrController } from "mcp-stdio-oauth/client/transport";

// ---------------------------------------------------------------------------
// Experimental v2-beta MCP protocol support (spec revision 2026-07-28).
//
// When the `mcpBetaProtocol` experimental setting is on, connections are built
// on `@modelcontextprotocol/client` (the v2 SDK, pinned to an exact beta
// version in package.json — its public API may still change before stable)
// instead of `@modelcontextprotocol/sdk` v1. The v2 client is created with
// `versionNegotiation: { mode: 'auto' }`: it probes each server with
// `server/discover` and speaks the new stateless 2026-07-28 protocol when the
// server supports it, transparently falling back to the classic `initialize`
// handshake for every existing (2025-era) server — so turning the toggle on
// must never break a working server.
//
// The v2 Client is method-compatible with every call FLUJO makes on a v1
// Client (connect/listTools/callTool/listResources/readResource/
// listResourceTemplates/listPrompts/getPrompt/sendRootsListChanged/close, plus
// the `transport` getter), so the instance is returned typed as the v1 Client
// and the rest of the MCP service stays untouched. The ONE deliberate
// signature difference is callTool (v1: (params, resultSchema?, options?);
// v2: (params, options?)) — call sites branch on isBetaClient() for it (see
// tools.ts). The marker fields below let shouldRecreateClient() and the call
// sites tell the generations apart.
// ---------------------------------------------------------------------------

const log = createLogger("backend/services/mcp/betaClient");

/**
 * Read the experimental `mcpBetaProtocol` flag from the persisted Settings
 * blob. Mirrors ModelHandler.isClaudeSessionResumeEnabled: in-process backend
 * read, best-effort — any failure (or a missing value) reads as disabled, so
 * connections keep the proven v1 SDK path.
 */
export async function isMcpBetaProtocolEnabled(): Promise<boolean> {
  try {
    const settings = await loadItem<Settings | undefined>(
      StorageKey.SPEECH_SETTINGS,
      undefined,
    );
    return Boolean(settings?.experimental?.mcpBetaProtocol);
  } catch (err) {
    log.warn("Failed to read mcpBetaProtocol setting; defaulting to disabled", {
      err,
    });
    return false;
  }
}

/** Whether a client (as stored in the connection map) was built by the beta path. */
export function isBetaClient(client: Client): boolean {
  return (client as unknown as ClientWithBetaMarker).__flujoBeta === true;
}

/**
 * Create a v2-beta MCP client for a server config, mirroring
 * connection.ts#createNewClient: same client identity, same capability policy
 * (roots always declared, sampling/elicitation under their trust policies, MCP
 * Apps only under the server's explicit opt-in), and
 * the SAME live-resolving roots/sampling behaviour — the v2
 * `setRequestHandler` takes a method string instead of a schema, but the
 * handler bodies are shared with the v1 registration (roots.ts/sampling.ts).
 *
 * Returned typed as the v1 Client so it can live in the shared connection map;
 * see the module comment for why that cast is sound.
 */
export function createNewBetaClient(config: MCPServerConfig): Client {
  const serverHasSampling = samplingEnabled(config);
  const serverHasElicitation = elicitationEnabled(config);
  const serverHasMcpApps = config.enableMcpApps === true;
  const serverHasStdioOAuth = config.transport === "stdio";
  const client = new BetaClient(
    {
      name: `flujo-${config.name}-client`,
      version: "3.42.0",
    },
    {
      capabilities: {
        roots: { listChanged: true },
        ...(serverHasSampling ? { sampling: {} } : {}),
        ...(serverHasStdioOAuth || serverHasElicitation
          ? {
              elicitation: {
                ...(serverHasStdioOAuth ? { url: {} } : {}),
                ...(serverHasElicitation ? { form: {} } : {}),
              },
            }
          : {}),
        extensions: {
          ...(serverHasStdioOAuth
            ? { [STDIO_OAUTH_EXTENSION_ID]: STDIO_OAUTH_EXTENSION_CAPABILITY }
            : {}),
          ...(serverHasMcpApps
            ? {
                [MCP_APPS_EXTENSION_ID]: {
                  mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
                },
              }
            : {}),
        },
      },
      // 'auto': probe for a 2026-07-28 server, fall back to the classic
      // initialize handshake on anything else. Never 'pin' — FLUJO must keep
      // working against every existing server.
      versionNegotiation: { mode: "auto" },
    },
  );

  client.setRequestHandler("roots/list", createRootsListHandler(config));
  if (serverHasSampling) {
    const handler = createSamplingHandler(config);
    client.setRequestHandler("sampling/createMessage", async (request) =>
      handler(request),
    );
  }
  if (serverHasStdioOAuth || serverHasElicitation) {
    const handler = createElicitationHandler(config);
    client.setRequestHandler("elicitation/create", async (request) =>
      handler(request),
    );
  }

  (client as unknown as ClientWithBetaMarker).__flujoBeta = true;
  // Same capability key the v1 factory stamps (see connection.ts ClientWithCapKey):
  // shouldRecreateClient compares it before its beta branch, so a beta client
  // without it would be needlessly rebuilt on every connect once sampling is on.
  (client as unknown as { __flujoCapKey?: string }).__flujoCapKey =
    capabilityKey(config);
  log.info(
    `Created v2-beta MCP client for ${config.name} (version negotiation: auto)`,
  );
  return client as unknown as Client;
}

/** Merge resolved custom headers into a RequestInit, like connection.ts does for v1. */
function betaRequestInit(config: {
  requestInit?: unknown;
  headers?: Record<string, MCPHeaderValue>;
}): RequestInit | undefined {
  let requestInit: RequestInit | undefined =
    config.requestInit && typeof config.requestInit === "object"
      ? (config.requestInit as RequestInit)
      : undefined;
  if (config.headers && typeof config.headers === "object") {
    const customHeaders = flattenCustomHeaders(config.headers);
    if (Object.keys(customHeaders).length > 0) {
      requestInit = {
        ...(requestInit || {}),
        headers: {
          ...((requestInit?.headers as Record<string, string>) || {}),
          ...customHeaders,
        },
      };
    }
  }
  return requestInit;
}

/**
 * Create a v2-beta transport for a server config, mirroring
 * connection.ts#createTransport: same resolved spawn parameters for stdio
 * (via resolveStdioLaunch), same header/OAuth/session material for HTTP, and
 * the same raw config keys stashed for shouldRecreateClient — plus the
 * __flujoKind marker its beta branch compares against.
 *
 * Websocket is NOT supported by the v2 SDK; callers must route websocket
 * configs to the v1 path (see connectServer).
 */
export function createBetaTransport(
  config: MCPServerConfig,
):
  | BetaStdioClientTransport
  | BetaStreamableHTTPClientTransport
  | BetaSSEClientTransport {
  if (config.transport === "websocket") {
    throw new Error(
      "The v2-beta MCP SDK has no websocket transport; use the v1 path",
    );
  }

  if (config.transport === "streamable") {
    const streamableConfig = config as MCPStreamableConfig;
    const options: BetaStreamableOptions = {};
    const requestInit = betaRequestInit(streamableConfig);
    if (requestInit) options.requestInit = requestInit;
    if (
      streamableConfig.reconnectionOptions &&
      typeof streamableConfig.reconnectionOptions === "object"
    ) {
      options.reconnectionOptions = streamableConfig.reconnectionOptions;
    }
    if (
      typeof streamableConfig.sessionId === "string" &&
      streamableConfig.sessionId.length > 0
    ) {
      options.sessionId = streamableConfig.sessionId;
    }
    if (
      streamableConfig.oauthClientId ||
      streamableConfig.oauthClientInformation
    ) {
      // FLUJO's provider implements the v1 OAuthClientProvider interface; the v2
      // interface matches it member-for-member on everything the SDK calls
      // (clientMetadata/state/clientInformation/saveClientInformation/tokens/
      // saveTokens/redirectToAuthorization/saveCodeVerifier/codeVerifier/
      // invalidateCredentials), with near-identical structural types — an
      // acceptable cast for the experimental path.
      options.authProvider = createOAuthClientProvider(
        streamableConfig,
      ) as unknown as BetaOAuthClientProvider;
    }
    const transport = new BetaStreamableHTTPClientTransport(
      new URL(streamableConfig.serverUrl),
      options,
    );
    const keyed = transport as unknown as TransportWithConfigKey;
    keyed.__flujoHttpKey = httpConfigKey(config);
    keyed.__flujoKind = "streamable";
    log.info(`Created v2-beta streamable transport for ${config.name}`);
    return transport;
  }

  if (config.transport === "sse") {
    const sseConfig = config as MCPSSEConfig;
    const options: BetaSseOptions = {};
    const requestInit = betaRequestInit(sseConfig);
    if (requestInit) options.requestInit = requestInit;
    if (
      sseConfig.eventSourceInit &&
      typeof sseConfig.eventSourceInit === "object"
    ) {
      options.eventSourceInit = sseConfig.eventSourceInit;
    }
    const transport = new BetaSSEClientTransport(
      new URL(sseConfig.serverUrl),
      options,
    );
    const keyed = transport as unknown as TransportWithConfigKey;
    keyed.__flujoHttpKey = httpConfigKey(config);
    keyed.__flujoKind = "sse";
    log.info(`Created v2-beta SSE transport for ${config.name}`);
    return transport;
  }

  // Default: stdio, spawned from the SAME resolved parameters as the v1 path.
  const { command, args, env, cwd } = resolveStdioLaunch(config);
  const transport = new BetaStdioClientTransport({
    command,
    args,
    env,
    cwd,
    stderr: "pipe",
  });
  const keyed = transport as unknown as TransportWithConfigKey;
  keyed.__flujoStdioKey = stdioConfigKey(config);
  keyed.__flujoKind = "stdio";
  stdioOAuthControllers.set(transport, new StdioOAuthDeferredMrtrController());
  log.info(`Created v2-beta stdio transport for ${config.name}`);
  return transport;
}

const stdioOAuthControllers = new WeakMap<
  BetaStdioClientTransport,
  StdioOAuthDeferredMrtrController
>();

/** Return the deferred MRTR controller for a beta stdio transport. */
export function getStdioOAuthMrtrController(
  transport: unknown,
): StdioOAuthMrtrController | undefined {
  return stdioOAuthControllers.get(transport as BetaStdioClientTransport);
}

/**
 * Attach the extension retry interceptor only after the SDK has completed era
 * negotiation and the MCP handshake. Keeping the exact base stdio transport
 * through connect is required for the SDK's disposable sibling probe and
 * legacy fallback.
 */
export function activateStdioOAuthMrtrController(transport: unknown): void {
  const stdioTransport = transport as BetaStdioClientTransport;
  stdioOAuthControllers.get(stdioTransport)?.attach(stdioTransport);
}

/**
 * The protocol version a beta client actually negotiated (e.g. "2026-07-28"
 * for a modern server, "2025-11-25"/older for the legacy fallback), for
 * post-connect logging. Undefined for v1 clients or before connect.
 */
export function negotiatedProtocolVersion(client: Client): string | undefined {
  if (!isBetaClient(client)) return undefined;
  try {
    return (client as unknown as BetaClient).getNegotiatedProtocolVersion();
  } catch {
    return undefined;
  }
}
