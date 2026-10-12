/** Modern Flows-as-tools serving. Legacy requests retain the original v1 route.
 * SDK admission/framing stays intact; Tasks use the pinned extension schemas.
 */
import {
  createMcpHandler, isLegacyRequest, ProtocolError, ProtocolErrorCode, Server,
  specTypeSchemas, CLIENT_CAPABILITIES_META_KEY, type ClientCapabilities, type Result, type ServerContext,
} from '@modelcontextprotocol/server';
import {
  CallToolResultV2Schema, CreateTaskResultV2Schema, GetTaskRequestV2Schema,
  GetTaskResultV2Schema, UpdateTaskRequestV2Schema, UpdateTaskResultV2Schema,
  CancelTaskRequestV2Schema, CancelTaskResultV2Schema, hasTaskClientCapabilityV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { FEATURES } from '@/config/features';
import { getCurrentWorkspace } from '@/utils/workspace';
import { isLocalRequest } from '@/utils/http/localRequest';
import { resolveOwnerRequest, type OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { executionExtensionAdapter, hasExecutionExtensionContext } from '@/backend/execution/extensions';
import { getAuthorizedBundledFlujoWorkloadToolNames } from '@/backend/services/security/bundledFlujoWorkload';
import { flowToolsListTools, flowToolsCallTool } from './flowTools';
import { authoringCallTool, authoringToolDefinitions, isAuthoringTool } from './flowAuthoringTools';
import { serverTaskStore, ServerTaskError } from './serverTasks';

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const OWNER_SCOPES = ['mcp:access', 'control:admin', 'secrets:read'] as const;

/** SDK body-primary classification; this does not consume the route's body. */
export function isLegacyFlowsMcpRequest(request: Request): Promise<boolean> {
  return isLegacyRequest(request);
}

function ordinaryTaskProfile(): boolean {
  return !isWorkerMode() && !executionExtensionAdapter() && !hasExecutionExtensionContext()
    && getAuthorizedBundledFlujoWorkloadToolNames() === undefined;
}

function admitted(auth: OwnerRequestAuthorization, workspace: string): void {
  if (workspace !== getCurrentWorkspace() || auth.recheck()) {
    throw new ServerTaskError('TASK_ACCESS_DENIED');
  }
}

function taskCapability(ctx: ServerContext): boolean {
  // The SDK lifts reserved metadata out of handler params after validation.
  return hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope });
}

function formCapability(ctx: ServerContext): boolean {
  // SDK 2.3.1's generated RequestMetaEnvelope type is empty although the
  // documented runtime context retains the checked modern envelope fields.
  const capabilities = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)
    ?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const elicitation = capabilities?.elicitation;
  // The SDK's modern capability rules retain bare elicitation:{} as form
  // support; declaring an explicit URL-only mode removes that implication.
  return elicitation !== undefined && (elicitation.form !== undefined
    || (elicitation.form === undefined && elicitation.url === undefined));
}

function taskFailure(error: unknown): never {
  if (error instanceof ServerTaskError) {
    if (error.code === 'TASK_NOT_FOUND' || error.code === 'TASK_ACCESS_DENIED') {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task is unavailable.');
    }
    if (error.code === 'TASK_INPUT_INVALID') {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid task input.');
    }
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'Task operation is unavailable.');
  }
  throw error;
}

/** Strict owner admission precedes modern SDK parsing and every task effect. */
export async function handleModernFlowsMcpRequest(request: Request): Promise<Response> {
  if (!isLocalRequest(request.headers.get('host'), request.headers.get('origin'))) {
    return Response.json({ error: 'Forbidden.' }, { status: 403 });
  }
  const resolved = resolveOwnerRequest(request, OWNER_SCOPES, { requireBearer: true });
  if (!resolved.ok) return resolved.response;
  const auth = resolved.authorization;
  const workspace = getCurrentWorkspace();
  const assertAuthorized = () => admitted(auth, workspace);
  const enabled = FEATURES.ENABLE_MCP_TASKS_SERVER === true && ordinaryTaskProfile();
  const assertTasks = (ctx: ServerContext) => {
    assertAuthorized();
    if (!enabled || FEATURES.ENABLE_MCP_TASKS_SERVER !== true || !ordinaryTaskProfile()
        || !taskCapability(ctx)) throw new ServerTaskError('TASK_ACCESS_DENIED');
  };

  const handler = createMcpHandler(() => {
    assertAuthorized();
    const server = new Server({ name: 'flujo-flows', version: '3.46.3' }, {
      capabilities: { tools: {}, ...(enabled ? { extensions: { [TASKS_EXTENSION]: {} } } : {}) },
    });
    server.setRequestHandler('tools/list', async () => {
      assertAuthorized();
      const authoring = authoringToolDefinitions();
      const listed = await flowToolsListTools();
      assertAuthorized();
      const result = await specTypeSchemas.ListToolsResult['~standard'].validate({
        tools: [...authoring, ...listed.tools.filter(tool => !isAuthoringTool(tool.name))],
      });
      if (result.issues) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Tool definitions are unavailable.');
      return result.value;
    });

    // Public fallback is restricted to tools/call. A registered core handler
    // validates only synchronous results and cannot return extension task types.
    server.fallbackRequestHandler = async (rpc, ctx): Promise<Result> => {
      if (rpc.method !== 'tools/call') throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found');
      assertAuthorized();
      const parsed = await specTypeSchemas.CallToolRequestParams['~standard'].validate(rpc.params);
      if (parsed.issues) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid tool call.');
      const { name, arguments: args = {} } = parsed.value;
      assertAuthorized();
      if (isAuthoringTool(name)) {
        const result = await authoringCallTool(name, args);
        assertAuthorized();
        return CallToolResultV2Schema.parse({ ...result, resultType: 'complete' });
      }

      // Resolve an actual authored tool before creating a durable task. Unknown
      // names keep the existing synchronous business error and create no work.
      const listed = await flowToolsListTools();
      assertAuthorized();
      const knownFlow = listed.tools.some(tool => tool.name === name);
      if (enabled && knownFlow && taskCapability(ctx)) {
        try {
          assertTasks(ctx);
          if (args.confirm === true && !formCapability(ctx)) return {
            resultType: 'complete', isError: true,
            content: [{ type: 'text', text: 'Confirmation requires negotiated form elicitation.' }],
          };
          const task = await serverTaskStore.create(auth, workspace, {
            run: async (execution) => {
              const assertTaskAuthorized = () => {
                execution.assertAuthorized();
                assertTasks(ctx);
              };
              assertTaskAuthorized();
              const result = await flowToolsCallTool(name, args, {
                abortSignal: execution.signal,
                assertAuthorized: assertTaskAuthorized,
                requestInput: async (requests) => {
                  assertTaskAuthorized();
                  if (!formCapability(ctx) || Object.values(requests).some(entry =>
                    entry.method !== 'elicitation/create' || entry.params.mode !== 'form')) {
                    throw new ServerTaskError('TASK_INPUT_INVALID');
                  }
                  const responses = await execution.requestInput(requests);
                  assertTaskAuthorized();
                  return responses;
                },
              });
              assertTaskAuthorized();
              return CallToolResultV2Schema.parse({ ...result, resultType: 'complete' });
            },
          });
          assertTasks(ctx);
          return CreateTaskResultV2Schema.parse(task);
        } catch (error) { return taskFailure(error); }
      }
      const result = await flowToolsCallTool(name, args, { abortSignal: request.signal, assertAuthorized });
      assertAuthorized();
      return CallToolResultV2Schema.parse({ ...result, resultType: 'complete' });
    };

    if (enabled) {
      server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params }, async (params, ctx) => {
        try {
          assertTasks(ctx);
          const task = await serverTaskStore.get(auth, workspace, params.taskId);
          assertTasks(ctx);
          if (task.status === 'input_required' && task.inputRequests && !formCapability(ctx)) {
            throw new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability,
              'Form elicitation capability is required.', { requiredCapabilities: { elicitation: { form: {} } } });
          }
          return GetTaskResultV2Schema.parse(task);
        } catch (error) { return taskFailure(error); }
      });
      // The SDK lifts inputResponses into the validated request context for all
      // modern methods. Reconstruct the extension params from that public field.
      server.setRequestHandler('tasks/update', {
        params: UpdateTaskRequestV2Schema.shape.params.omit({ inputResponses: true }),
      }, async (params, ctx) => {
        try {
          assertTasks(ctx);
          const input = UpdateTaskRequestV2Schema.shape.params.safeParse({
            ...params, inputResponses: ctx.mcpReq.inputResponses,
          });
          if (!input.success || ctx.mcpReq.droppedInputResponseKeys?.length) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid task input.');
          }
          const result = await serverTaskStore.update(auth, workspace, input.data.taskId, input.data.inputResponses);
          assertTasks(ctx);
          return UpdateTaskResultV2Schema.parse(result);
        } catch (error) { return taskFailure(error); }
      });
      server.setRequestHandler('tasks/cancel', { params: CancelTaskRequestV2Schema.shape.params }, async (params, ctx) => {
        try {
          assertTasks(ctx);
          const result = await serverTaskStore.cancel(auth, workspace, params.taskId);
          assertTasks(ctx);
          return CancelTaskResultV2Schema.parse(result);
        } catch (error) { return taskFailure(error); }
      });
    }
    return server;
  }, { legacy: 'reject', maxRequestBodySize: 256 * 1024 });
  try {
    assertAuthorized();
    const response = await handler.fetch(request);
    const denied = auth.recheck();
    if (denied) { await response.body?.cancel().catch(() => undefined); return denied; }
    return response;
  } finally {
    // Per-request SDK state is disposable. Durable jobs own separate signals.
    await handler.close();
  }
}
