/**
 * Model-to-agent conversion (issue #496).
 *
 * This is intentionally an intent-only boundary: callers provide identifiers
 * and selections, never graph JSON or credentials. The backend revalidates the
 * live model/MCP inventory, reuses Quick Chat graph synthesis, lays the graph
 * out top-to-bottom, and persists it through the canonical Flow service.
 */
import { flowService } from '@/backend/services/flow';
import { createLogger } from '@/utils/logger';
import { computeAutoLayout } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/autoLayout';
import { sanitizeFlowName } from '@/utils/shared/flowSpecCompiler';
import {
  QuickChatServerSelection,
  synthesizeQuickChatFlow,
} from '@/utils/shared/quickChat';
import { gatherGenerationContext } from './generationContext';

const log = createLogger('backend/services/flow/modelAgent');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CreateModelAgentRequest {
  creationId: string;
  modelId: string;
  name: string;
  servers?: QuickChatServerSelection[];
  systemPrompt?: string;
}

export type CreateModelAgentResult =
  | { success: true; flowId: string; name: string; reused?: boolean }
  | { success: false; error: string; statusCode: number };

export async function createModelAgent(
  request: CreateModelAgentRequest,
): Promise<CreateModelAgentResult> {
  if (!UUID_PATTERN.test(request.creationId)) {
    return { success: false, error: 'A valid creationId is required.', statusCode: 400 };
  }
  if (!request.modelId || typeof request.modelId !== 'string') {
    return { success: false, error: 'A model is required.', statusCode: 400 };
  }
  if (!request.name || typeof request.name !== 'string') {
    return { success: false, error: 'An agent name is required.', statusCode: 400 };
  }

  // The client reuses one UUID while retrying. A completed first request is
  // therefore returned instead of creating a second flow after an uncertain
  // network failure. A UUID collision with a different model fails closed.
  const existing = await flowService.getFlow(request.creationId);
  if (existing) {
    const existingModel = existing.nodes.find((node) => node.type === 'process')
      ?.data.properties?.boundModel;
    if (existingModel !== request.modelId) {
      return { success: false, error: 'That creationId is already in use.', statusCode: 409 };
    }
    return {
      success: true,
      flowId: existing.id,
      name: existing.name,
      reused: true,
    };
  }

  const context = await gatherGenerationContext();
  if (!context.blocks.models.some((model) => model.id === request.modelId)) {
    return { success: false, error: 'The selected model is no longer available.', statusCode: 400 };
  }

  const connectedServers = new Set(
    context.blocks.servers
      .filter((server) => server.connected)
      .map((server) => server.name),
  );
  for (const selected of request.servers ?? []) {
    if (!selected?.name || typeof selected.name !== 'string') {
      return { success: false, error: 'A selected app is missing its name.', statusCode: 400 };
    }
    if (!connectedServers.has(selected.name)) {
      return {
        success: false,
        error: `The connected app "${selected.name}" is no longer available.`,
        statusCode: 400,
      };
    }
    if (
      selected.enabledTools !== undefined
      && (
        !Array.isArray(selected.enabledTools)
        || selected.enabledTools.some((tool) => typeof tool !== 'string')
      )
    ) {
      return {
        success: false,
        error: `The tool selection for "${selected.name}" is invalid.`,
        statusCode: 400,
      };
    }
  }

  const existingNames = context.blocks.flows.map((flow) => flow.name);
  // Leave room for the established _2/_3 collision suffix while the canonical
  // persistence boundary still enforces the display-name limit.
  const name = sanitizeFlowName(request.name.slice(0, 150), existingNames);
  const synthesized = synthesizeQuickChatFlow(
    {
      modelId: request.modelId,
      servers: request.servers,
      systemPrompt: request.systemPrompt,
    },
    {
      models: context.compile.models ?? [],
      // Conversion is stricter than Quick Chat: only currently connected
      // servers enter the compiler context.
      servers: context.blocks.servers
        .filter((server) => server.connected)
        .map((server) => ({ name: server.name })),
      serverTools: context.compile.serverTools,
    },
    { flowId: request.creationId, flowName: name },
  );

  if (!synthesized.flow) {
    return {
      success: false,
      error: synthesized.error ?? 'Could not create the agent graph.',
      statusCode: 400,
    };
  }

  const flow = synthesized.flow;
  flow.personaOwnership = undefined;
  flow.nodes = computeAutoLayout(flow.nodes, flow.edges, { direction: 'TB' });

  const saved = await flowService.saveFlow(flow);
  if (!saved.success) {
    log.warn('Model-agent persistence failed', {
      flowId: request.creationId,
      modelId: request.modelId,
    });
    return {
      success: false,
      error: saved.error ?? 'Could not save the agent.',
      statusCode: 500,
    };
  }

  log.info('Created model agent', {
    flowId: flow.id,
    modelId: request.modelId,
    serverCount: request.servers?.length ?? 0,
  });
  return { success: true, flowId: flow.id, name: flow.name };
}
