import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createStdioOAuthClient,
  validateElicitationUrl,
  type StdioOAuthClient,
  type StdioOAuthMcpClient,
  type StdioOAuthMrtrController,
} from "mcp-stdio-oauth/client";
import {
  STDIO_OAUTH_EXTENSION_CAPABILITY,
  STDIO_OAUTH_EXTENSION_ID,
  STDIO_OAUTH_EXTENSION_VERSION,
} from "mcp-stdio-oauth/protocol";
import type {
  MCPStdioOAuthAuthorization,
  MCPStdioOAuthStatus,
} from "@/shared/types/mcp";
import { createLogger } from "@/utils/logger";

const log = createLogger("backend/services/mcp/externalAuthorization");

/**
 * FLUJO host integration for the experimental mcp-stdio-oauth extension. This
 * is deliberately not MCP transport OAuth: a stdio child owns its downstream
 * provider credentials and tokens, while FLUJO coordinates browser consent and
 * gates unattended calls on the readiness reported through the shared package.
 */
export const MCP_EXTERNAL_AUTHORIZATION_EXTENSION_ID = STDIO_OAUTH_EXTENSION_ID;
export const MCP_EXTERNAL_AUTHORIZATION_VERSION = STDIO_OAUTH_EXTENSION_VERSION;

export const MCP_EXTERNAL_AUTHORIZATION_CLIENT_CAPABILITY = {
  ...STDIO_OAUTH_EXTENSION_CAPABILITY,
} as const;

type CachedStatus = {
  value: MCPStdioOAuthStatus;
  timestamp: number;
};

export interface ExternalAuthorizationPrompt {
  sessionId: string;
  authorizationId: string;
  url: string;
  origin: string;
  hasPunycode: boolean;
  message?: string;
  alreadyReady?: boolean;
}

type PendingSession = {
  sessionId: string;
  serverName: string;
  authorizationId: string;
  createdAt: number;
  prompt?: ExternalAuthorizationPrompt;
  resolvePrompt: (prompt: ExternalAuthorizationPrompt) => void;
  rejectPrompt: (error: Error) => void;
  promptPromise: Promise<ExternalAuthorizationPrompt>;
  resolveElicitation?: (result: ElicitResult) => void;
  elicitationResponded?: boolean;
  abortController: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};

interface ClientWithStdioOAuthMarker {
  __flujoStdioOAuth?: true;
}

declare global {
  var __mcp_external_authorization_status:
    Map<string, CachedStatus> | undefined;
  var __mcp_external_authorization_sessions:
    Map<string, PendingSession> | undefined;
  var __mcp_stdio_oauth_clients: WeakMap<object, StdioOAuthClient> | undefined;
}

const statusCache =
  global.__mcp_external_authorization_status ??
  (global.__mcp_external_authorization_status = new Map());
const pendingSessions =
  global.__mcp_external_authorization_sessions ??
  (global.__mcp_external_authorization_sessions = new Map());
const stdioOAuthClients =
  global.__mcp_stdio_oauth_clients ??
  (global.__mcp_stdio_oauth_clients = new WeakMap());

const STATUS_CACHE_MS = 2_000;
const STATUS_TIMEOUT_MS = 8_000;
const PREPARE_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 5 * 60_000;

/**
 * Bind the package helper to a client before connect. Calling this function is
 * also FLUJO's record that it advertised the extension. Only local stdio
 * clients are bound; a remote server cannot opt FLUJO into the contract by
 * advertising the server capability unilaterally.
 */
export function registerExternalAuthorizationClient(
  client: Client,
  serverName: string,
  mrtrController?: StdioOAuthMrtrController,
): void {
  if (stdioOAuthClients.has(client)) return;

  const oauth = createStdioOAuthClient({
    mcpClient: client as unknown as StdioOAuthMcpClient,
    installElicitationHandler: false,
    ...(mrtrController ? { mrtrController } : {}),
    onUrlElicitation: async (request) => {
      const result = await captureExternalAuthorizationElicitation(serverName, {
        mode: request.mode,
        url: request.target.href,
        message: request.message,
      });
      return result ?? { action: "cancel" };
    },
  });

  stdioOAuthClients.set(client, oauth);
  (client as unknown as ClientWithStdioOAuthMarker).__flujoStdioOAuth = true;
}

function externalAuthorizationClient(client: Client): StdioOAuthClient {
  const oauth = stdioOAuthClients.get(client);
  if (!oauth) {
    throw new Error("This MCP client did not negotiate mcp-stdio-oauth.");
  }
  return oauth;
}

export function serverSupportsExternalAuthorization(
  client: Client | undefined,
): boolean {
  if (!client) return false;
  const offered =
    (client as unknown as ClientWithStdioOAuthMarker).__flujoStdioOAuth ===
    true;
  const oauth = stdioOAuthClients.get(client);
  return offered && Boolean(oauth?.isSupported());
}

function blockingAuthorization(
  authorizations: MCPStdioOAuthAuthorization[],
): MCPStdioOAuthAuthorization | undefined {
  return authorizations.find(
    (authorization) =>
      authorization.blocksUnattendedUse && authorization.state !== "ready",
  );
}

export async function getExternalAuthorizationStatus(
  client: Client | undefined,
  serverName: string,
  options: { force?: boolean } = {},
): Promise<MCPStdioOAuthStatus> {
  if (!serverSupportsExternalAuthorization(client)) {
    return { supported: false, authorizations: [] };
  }

  const cached = statusCache.get(serverName);
  if (
    !options.force &&
    cached &&
    Date.now() - cached.timestamp < STATUS_CACHE_MS
  ) {
    return cached.value;
  }

  const result = await externalAuthorizationClient(client!).getStatus({
    timeout: STATUS_TIMEOUT_MS,
  });
  const authorizations = result.authorizations.map((authorization) => ({
    id: authorization.id,
    ...(authorization.provider ? { provider: authorization.provider } : {}),
    label: authorization.label,
    state: authorization.state,
    blocksUnattendedUse: authorization.blocksUnattendedUse,
    ...(authorization.message ? { message: authorization.message } : {}),
  }));
  const value: MCPStdioOAuthStatus = {
    supported: true,
    authorizations,
    blockingAuthorization: blockingAuthorization(authorizations),
  };
  statusCache.set(serverName, { value, timestamp: Date.now() });
  return value;
}

export function invalidateExternalAuthorizationStatus(
  serverName: string,
): void {
  statusCache.delete(serverName);
}

function publishPrompt(
  session: PendingSession,
  rawUrl: string,
  message?: string,
): ExternalAuthorizationPrompt {
  if (session.prompt) return session.prompt;
  const target = validateElicitationUrl(rawUrl);
  const prompt: ExternalAuthorizationPrompt = {
    sessionId: session.sessionId,
    authorizationId: session.authorizationId,
    url: target.href,
    origin: target.origin,
    hasPunycode: target.hasPunycode,
    ...(message ? { message } : {}),
  };
  session.prompt = prompt;
  session.resolvePrompt(prompt);
  return prompt;
}

function findPendingSession(serverName: string): PendingSession | undefined {
  return Array.from(pendingSessions.values())
    .filter((session) => session.serverName === serverName)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function removeSession(session: PendingSession): void {
  if (session.timer) clearTimeout(session.timer);
  pendingSessions.delete(session.sessionId);
}

export function cancelExternalAuthorization(
  serverName: string,
  sessionId?: string,
): boolean {
  const session = sessionId
    ? pendingSessions.get(sessionId)
    : findPendingSession(serverName);
  if (!session || session.serverName !== serverName) return false;
  if (session.resolveElicitation) {
    const resolve = session.resolveElicitation;
    session.resolveElicitation = undefined;
    session.elicitationResponded = true;
    resolve({ action: "cancel" });
  } else if (session.elicitationResponded) {
    // The consent response was already returned, but the enclosing start
    // request has not settled. Abort it and keep the correlation record until
    // its promise finalizer runs; otherwise a late input request from this
    // start could be mistaken for a new session.
    session.abortController.abort();
  } else {
    // If start has not produced an input request yet, cancel the MCP request so
    // a late URL cannot survive this UI session and attach to a later one.
    // Keep the tombstone until the start promise settles: correlation is by
    // server/client helper, so removing it early could let that late URL attach
    // to a replacement session.
    session.abortController.abort();
  }
  session.rejectPrompt(new Error("Authorization was cancelled."));
  return true;
}

export function declineExternalAuthorization(
  serverName: string,
  sessionId: string,
): boolean {
  const session = pendingSessions.get(sessionId);
  if (
    !session ||
    session.serverName !== serverName ||
    !session.prompt ||
    !session.resolveElicitation
  ) {
    return false;
  }

  const resolve = session.resolveElicitation;
  session.resolveElicitation = undefined;
  session.elicitationResponded = true;
  resolve({ action: "decline" });
  invalidateExternalAuthorizationStatus(serverName);
  return true;
}

/**
 * Captures URL-mode elicitation only while a user-started extension request is
 * pending. Every other URL elicitation is cancelled, so a background flow can
 * never make a browser prompt appear asynchronously.
 */
export async function captureExternalAuthorizationElicitation(
  serverName: string,
  params: {
    mode?: string;
    url?: string;
    message?: string;
  },
): Promise<ElicitResult | undefined> {
  if (params.mode !== "url") return undefined;
  const session = findPendingSession(serverName);

  if (typeof params.url !== "string" || params.url.length === 0) {
    if (session) {
      session.rejectPrompt(
        new Error("The MCP server supplied a malformed authorization URL."),
      );
      session.abortController.abort();
    }
    return { action: "cancel" };
  }

  if (!session) {
    log.warn(`Rejected unsolicited URL elicitation from ${serverName}`);
    return { action: "cancel" };
  }

  if (session.abortController.signal.aborted) {
    log.warn(`Rejected URL elicitation from cancelled start on ${serverName}`);
    return { action: "cancel" };
  }

  // One URL consent decision is allowed per explicit start. A repeated or
  // concurrent URL request must not overwrite the resolver for the first one
  // or create a prompt after the user already responded.
  if (session.resolveElicitation || session.elicitationResponded) {
    log.warn(`Rejected duplicate URL elicitation from ${serverName}`);
    return { action: "cancel" };
  }

  try {
    publishPrompt(session, params.url, params.message);
  } catch (error) {
    session.rejectPrompt(
      error instanceof Error ? error : new Error(String(error)),
    );
    session.abortController.abort();
    return { action: "cancel" };
  }

  return new Promise<ElicitResult>((resolve) => {
    session.resolveElicitation = resolve;
  });
}

/**
 * Begins the fixed extension start request and returns as soon as its URL has
 * been captured. The MCP request itself may remain suspended in URL-mode
 * elicitation until confirmExternalAuthorization() records the second click.
 */
export async function prepareExternalAuthorization(
  client: Client,
  serverName: string,
  authorizationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ExternalAuthorizationPrompt> {
  options.signal?.throwIfAborted();
  if (!serverSupportsExternalAuthorization(client)) {
    throw new Error(
      "This MCP server did not negotiate external authorization support.",
    );
  }

  // Refresh immediately before start so the opaque ID is guaranteed to come
  // from this helper's latest successful status result, even if a caller did
  // not arrive through the HTTP route's earlier UI-oriented status check.
  const latestStatus = await getExternalAuthorizationStatus(
    client,
    serverName,
    {
      force: true,
    },
  );
  const latestAuthorization = latestStatus.authorizations.find(
    (authorization) => authorization.id === authorizationId,
  );
  if (!latestAuthorization) {
    throw new Error(
      "The OAuth authorization is no longer available. Refresh and try again.",
    );
  }
  if (latestAuthorization.state === "ready") {
    return {
      sessionId: crypto.randomUUID(),
      authorizationId,
      url: "",
      origin: "",
      hasPunycode: false,
      alreadyReady: true,
    };
  }

  const previousSession = findPendingSession(serverName);
  if (previousSession) {
    cancelExternalAuthorization(serverName, previousSession.sessionId);
    if (pendingSessions.has(previousSession.sessionId)) {
      throw new Error(
        "The previous authorization request is still closing. Try again in a moment.",
      );
    }
  }

  options.signal?.throwIfAborted();

  let resolvePrompt!: (prompt: ExternalAuthorizationPrompt) => void;
  let rejectPrompt!: (error: Error) => void;
  const promptPromise = new Promise<ExternalAuthorizationPrompt>(
    (resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    },
  );
  const session: PendingSession = {
    sessionId: crypto.randomUUID(),
    serverName,
    authorizationId,
    createdAt: Date.now(),
    resolvePrompt,
    rejectPrompt,
    promptPromise,
    abortController: new AbortController(),
  };
  session.timer = setTimeout(() => {
    const resolve = session.resolveElicitation;
    session.resolveElicitation = undefined;
    session.elicitationResponded = true;
    resolve?.({ action: "cancel" });
    session.abortController.abort();
    session.rejectPrompt(new Error("Authorization request timed out."));
  }, SESSION_TIMEOUT_MS);
  pendingSessions.set(session.sessionId, session);

  const cancelFromCaller = (): void => {
    cancelExternalAuthorization(serverName, session.sessionId);
  };
  options.signal?.addEventListener("abort", cancelFromCaller, { once: true });

  void externalAuthorizationClient(client)
    .start(authorizationId, {
      timeout: SESSION_TIMEOUT_MS,
      signal: session.abortController.signal,
    })
    .then(async (result) => {
      invalidateExternalAuthorizationStatus(serverName);
      if (result.state === "ready") {
        session.resolvePrompt({
          sessionId: session.sessionId,
          authorizationId,
          url: "",
          origin: "",
          hasPunycode: false,
          alreadyReady: true,
        });
        removeSession(session);
        return;
      }

      const status = await getExternalAuthorizationStatus(client, serverName, {
        force: true,
      });
      const requestedAuthorization = status.authorizations.find(
        (authorization) => authorization.id === authorizationId,
      );
      if (requestedAuthorization?.state === "ready") {
        session.resolvePrompt({
          sessionId: session.sessionId,
          authorizationId,
          url: "",
          origin: "",
          hasPunycode: false,
          alreadyReady: true,
        });
        removeSession(session);
        return;
      }

      session.rejectPrompt(
        new Error(
          "The MCP server completed OAuth start without URL elicitation or ready status.",
        ),
      );
      removeSession(session);
    })
    .catch((error) => {
      session.rejectPrompt(
        error instanceof Error ? error : new Error(String(error)),
      );
    })
    .finally(() => {
      removeSession(session);
    });

  let prepareTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promptPromise,
      new Promise<never>((_resolve, reject) => {
        prepareTimer = setTimeout(
          () =>
            reject(
              new Error(
                "The MCP server did not present an authorization URL in time.",
              ),
            ),
          PREPARE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    // Do not leave a late server response able to create a browser prompt after
    // the initiating HTTP request has already timed out and the UI moved on.
    cancelExternalAuthorization(serverName, session.sessionId);
    throw error;
  } finally {
    if (prepareTimer) clearTimeout(prepareTimer);
    options.signal?.removeEventListener("abort", cancelFromCaller);
  }
}

export function confirmExternalAuthorization(
  serverName: string,
  sessionId: string,
): ExternalAuthorizationPrompt {
  const session = pendingSessions.get(sessionId);
  if (!session || session.serverName !== serverName || !session.prompt) {
    throw new Error(
      "The authorization request is no longer active. Start it again.",
    );
  }
  if (!session.resolveElicitation || session.elicitationResponded) {
    throw new Error(
      "The authorization request is no longer awaiting consent. Start it again.",
    );
  }
  const resolve = session.resolveElicitation;
  session.resolveElicitation = undefined;
  session.elicitationResponded = true;
  resolve({ action: "accept" });
  invalidateExternalAuthorizationStatus(serverName);
  const prompt = session.prompt;
  // Keep the session record until the underlying start request settles. This
  // prevents a delayed response from the old request from being correlated
  // with a newly-created session for the same server. The URL is returned only
  // for this consent response and is never cached as readiness.
  return prompt;
}

export function clearExternalAuthorizationState(serverName: string): void {
  invalidateExternalAuthorizationStatus(serverName);
  for (const session of Array.from(pendingSessions.values())) {
    if (session.serverName !== serverName) continue;
    session.resolveElicitation?.({ action: "cancel" });
    session.abortController.abort();
    session.rejectPrompt(
      new Error(
        "Authorization was cancelled because the MCP connection closed.",
      ),
    );
    removeSession(session);
  }
}
