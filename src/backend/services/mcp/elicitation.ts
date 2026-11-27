import { registerTaskInputHandler, assertTaskInputCurrent, type TaskInputOptions } from './taskInputHandlers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ElicitResult,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig } from '@/shared/types/mcp';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { getElicitationContext } from './elicitationContext';
import {
  registerPendingElicitation,
  cancelConversationElicitation,
  completeServerUrlElicitation,
  URL_ELICITATION_TIMEOUT_MS,
  type PendingElicitationMetadata,
} from './elicitationRegistry';
import { captureExternalAuthorizationElicitation } from './externalAuthorization';
import { relatedTaskIdOf } from '@/shared/types/mcp/tasks';
import {
  noteTaskInputRequested,
  noteTaskInputResolved,
} from './taskInputRegistry';
import { bindToCurrentWorkspace } from '@/utils/workspace';
import { mcpElicitationEnabled } from '@/shared/utils/mcpClientFeatures';
import { vetElicitationUrl } from '@/shared/utils/elicitationUrl';

const log = createLogger('backend/services/mcp/elicitation');

/** A tool call may need at most this many links before FLUJO gives up. */
const MAX_REQUIRED_URL_ELICITATIONS = 4;
const MAX_SERVER_ELICITATION_ID_LENGTH = 256;

/** Elicitation is on unless the user turned it off for this server. */
export function elicitationEnabled(config: MCPServerConfig): boolean {
  return mcpElicitationEnabled(config);
}

/**
 * Stable key of the elicitation policy, concatenated with the sampling key in
 * capabilityKey() so toggling elicitation forces a client rebuild.
 */
export function elicitationConfigKey(config: MCPServerConfig): string {
  return elicitationEnabled(config) ? 'e:1' : '';
}

/**
 * The elicitation capability FLUJO declares to a server: forms and links when
 * elicitation is on. A local (stdio) server always gets link mode, because its
 * account sign-in (mcp-stdio-oauth) needs it even when forms are off.
 */
export function elicitationCapability(config: MCPServerConfig): { form?: Record<string, never>; url?: Record<string, never> } | undefined {
  const asks = elicitationEnabled(config);
  const stdioSignIn = config.transport === 'stdio' && config.isolation === undefined;
  if (!asks && !stdioSignIn) return undefined;
  return { ...(asks ? { form: {} } : {}), url: {} };
}

/**
 * Register the `elicitation/create` handler and the completion notice on a v1
 * SDK client. Form and general link requests follow the server's switch; the
 * sign-in link of a local server is handled by externalAuthorization.ts.
 */
export function registerElicitationHandler(client: Client, config: MCPServerConfig): void {
  const handler = createElicitationHandler(config);
  registerTaskInputHandler(client, 'elicitation/create', handler);
  client.setRequestHandler(ElicitRequestSchema, handler);
  client.setNotificationHandler(ElicitationCompleteNotificationSchema, createElicitationCompleteHandler(config.name));
}

/** `notifications/elicitation/complete`: the server saw the person finish a link. */
export function createElicitationCompleteHandler(serverName: string): (notification: { params?: unknown }) => void {
  return bindToCurrentWorkspace((notification: { params?: unknown }) => {
    const id = (notification.params as { elicitationId?: unknown } | undefined)?.elicitationId;
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_SERVER_ELICITATION_ID_LENGTH) {
      completeServerUrlElicitation(serverName, id);
    }
  });
}

type ElicitParams = {
  mode?: string;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  elicitationId?: string;
  url?: string;
  _meta?: Record<string, unknown>;
};

type ElicitationPrompt =
  | { mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
  | { mode: 'url'; message: string; url: string; serverElicitationId?: string };

function serverElicitationIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SERVER_ELICITATION_ID_LENGTH ? value : undefined;
}

function promptOf(params: ElicitParams): ElicitationPrompt {
  const message = typeof params.message === 'string' && params.message ? params.message : 'Additional information required';
  if ((params.mode ?? 'form') === 'form') {
    return { mode: 'form', message, requestedSchema: params.requestedSchema ?? { type: 'object', properties: {} } };
  }
  if (params.mode !== 'url') throw new McpError(ErrorCode.InvalidParams, 'FLUJO supports the form and url elicitation modes.');
  const vetted = vetElicitationUrl(params.url);
  if (!vetted) throw new McpError(ErrorCode.InvalidParams, 'FLUJO only opens https links, or http links to this computer, without a user name in them.');
  const serverElicitationId = serverElicitationIdOf(params.elicitationId);
  return { mode: 'url', message, url: vetted.href, ...(serverElicitationId ? { serverElicitationId } : {}) };
}

/**
 * Show one request to the person in the run that called the tool and wait for
 * the answer. Background runs wait too, with the same bound; the request shows
 * in the conversation and in the approvals inbox, and it cancels itself when
 * nobody answers in time.
 */
async function askPerson(
  serverName: string,
  prompt: ElicitationPrompt,
  options: TaskInputOptions,
  relatedTaskId?: string,
): Promise<ElicitResult> {
  const ctx = getElicitationContext(serverName);
  if (options.expectedConversationId !== undefined && ctx?.conversationId !== options.expectedConversationId) return { action: 'cancel' };
  if (!ctx) {
    // Outside a run (for example a test call from the server settings) there
    // is no conversation to show the request in.
    log.warn(`Elicitation request from ${serverName} outside an active run${relatedTaskId ? ` (task ${relatedTaskId})` : ''}; auto-cancelling`);
    return { action: 'cancel' };
  }

  const elicitationId = crypto.randomUUID();
  log.info(`Waiting for ${prompt.mode} elicitation ${elicitationId} from ${serverName} in conv ${ctx.conversationId}${ctx.getUnattended() ? ' (background run)' : ''}`);
  if (relatedTaskId) {
    noteTaskInputRequested(serverName, relatedTaskId, elicitationId);
  }

  await assertTaskInputCurrent(options);
  if (getElicitationContext(serverName) !== ctx) return { action: 'cancel' };
  const metadata: PendingElicitationMetadata = { ...prompt, conversationId: ctx.conversationId, serverName };
  // Install the mailbox before publishing the request, including fast answers.
  const pending = registerPendingElicitation(
    elicitationId, prompt.mode === 'url' ? URL_ELICITATION_TIMEOUT_MS : undefined, metadata,
  );
  const emit = executionEventBus.emitterFor(ctx.conversationId);
  const cancel = bindToCurrentWorkspace(() => {
    if (cancelConversationElicitation(ctx.conversationId, elicitationId)) emit({ type: 'run:elicitation_cancelled', elicitationId });
  });
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  else emit({
    type: 'run:awaiting_elicitation', elicitationId, message: prompt.message, serverName, mode: prompt.mode,
    ...(prompt.mode === 'url' ? { url: prompt.url } : { requestedSchema: prompt.requestedSchema }),
  });

  let result: ElicitResult;
  try {
    if (options.signal?.aborted) cancel();
    result = await pending;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
  log.info(`Elicitation ${elicitationId} resolved with action=${result.action}`);
  if (relatedTaskId) {
    // Idempotent: a duplicate submission for the same id is ignored.
    noteTaskInputResolved(serverName, relatedTaskId, elicitationId, result.action);
  }
  return result;
}

/**
 * The `elicitation/create` handler body, shared by the v1 registration above
 * and the v2 client (betaClient.ts, which also uses it for 2026-07-28
 * `input_required` results).
 *
 * A link that belongs to a local server's account sign-in goes to
 * externalAuthorization.ts. Every other form or link request is shown in the
 * run that called the tool, unless the user turned elicitation off.
 */
export function createElicitationHandler(
  config: MCPServerConfig
): (request: { params?: unknown }, options?: TaskInputOptions) => Promise<ElicitResult> {
  return bindToCurrentWorkspace(async (request: { params?: unknown }, options: TaskInputOptions = {}): Promise<ElicitResult> => {
    await assertTaskInputCurrent(options);
    const params = (request.params ?? {}) as ElicitParams;

    // MCP Tasks (#404): a server asks for the input a task is waiting on by
    // relating an ordinary elicitation to the task via
    // `_meta["io.modelcontextprotocol/related-task"]`. Answering it IS the task
    // update (the resolved spec/SDK has no `tasks/update`), so the two channels
    // are correlated here for the client task poll loop. Only ids are recorded —
    // never the prompt, schema or the user's answer.
    const relatedTaskId = relatedTaskIdOf(params._meta);

    const externalAuthorizationResult =
      await captureExternalAuthorizationElicitation(config.name, params);
    await assertTaskInputCurrent(options);
    if (externalAuthorizationResult) return externalAuthorizationResult;

    if (!elicitationEnabled(config)) {
      // Only the sign-in link mode was declared; a form is a mode the server
      // was never offered.
      if (params.mode === 'url') return { action: 'cancel' };
      throw new McpError(ErrorCode.InvalidParams, 'Elicitation is turned off for this server');
    }

    const result = await askPerson(config.name, promptOf(params), options, relatedTaskId);
    await assertTaskInputCurrent(options);
    return result;
  });
}

export interface RequiredUrlElicitation {
  serverElicitationId: string;
  url: string;
  message: string;
}

/**
 * Reads a `URLElicitationRequiredError` (-32042): the tool call can go on only
 * after the person opens one or more links. Anything malformed is not treated
 * as a link request.
 */
export function requiredUrlElicitationsOf(
  protocolError: { code: number; data?: unknown } | undefined,
): RequiredUrlElicitation[] | undefined {
  if (protocolError?.code !== ErrorCode.UrlElicitationRequired) return undefined;
  const list = (protocolError.data as { elicitations?: unknown } | undefined)?.elicitations;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REQUIRED_URL_ELICITATIONS) return undefined;
  const links: RequiredUrlElicitation[] = [];
  for (const entry of list as Array<Record<string, unknown> | null>) {
    const serverElicitationId = serverElicitationIdOf(entry?.elicitationId);
    const vetted = vetElicitationUrl(entry?.url);
    if (entry?.mode !== 'url' || !serverElicitationId || !vetted || typeof entry.message !== 'string') return undefined;
    links.push({ serverElicitationId, url: vetted.href, message: entry.message });
  }
  return links;
}

/**
 * Asks the person to open every link a tool call needs, one after another.
 * True only when they finished all of them, so the caller may try the tool
 * call again.
 */
export async function completeRequiredUrlElicitations(
  config: MCPServerConfig,
  links: readonly RequiredUrlElicitation[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!elicitationEnabled(config)) return false;
  const ask = bindToCurrentWorkspace(askPerson);
  for (const link of links) {
    const result = await ask(config.name, { mode: 'url', ...link }, signal ? { signal } : {});
    if (result.action !== 'accept') return false;
  }
  return true;
}
