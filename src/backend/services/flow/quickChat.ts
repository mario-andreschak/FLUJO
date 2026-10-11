/**
 * Quick-Chats (issue #61) — backend service.
 *
 * Resolves the model and bundled discovery connection, then hands them to the pure
 * {@link synthesizeQuickChatFlow} synthesizer, which builds an ephemeral flow
 * from validated SELECTIONS (never a caller-supplied graph). The resulting flow
 * is run WITHOUT being saved to the flows store — it travels with the
 * conversation state as a `flowSnapshot`.
 */
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { shippedDescriptorForConfig } from '@/backend/services/mcp/shippedServers';
import {
  QuickChatSelection,
  synthesizeQuickChatFlow,
  QUICK_CHAT_DISCOVERY_TOOLS,
} from '@/utils/shared/quickChat';

const log = createLogger('backend/services/flow/quickChat');

export interface BuildQuickChatSuccess {
  success: true;
  flow: Flow;
}

export interface BuildQuickChatFailure {
  success: false;
  error: string;
  statusCode: number;
}

export type BuildQuickChatResult = BuildQuickChatSuccess | BuildQuickChatFailure;

/**
 * Synthesize (but do not run) a quick-chat flow from selections. Resolves the
 * model and servers against the live configuration; rejects unknown ids and
 * attaches the discovery bootstrap and intersects explicit extra tools with
 * what their server exposes.
 */
export async function buildQuickChatFlow(
  selection: QuickChatSelection
): Promise<BuildQuickChatResult> {
  // Read identities first. Starting a chat does not inventory every app or flow;
  // the model discovers those capabilities through the small bootstrap catalog.
  const [models, configs] = await Promise.all([
    modelService.loadModels(),
    mcpService.loadServerConfigs(),
  ]);
  if (!Array.isArray(configs)) {
    return { success: false, error: configs.error ?? 'Could not load connected apps. Try again.', statusCode: 503 };
  }
  const enabled = configs.filter((config) => !config.disabled);
  const discovery = enabled.find((config) => config.transport === 'stdio'
    && shippedDescriptorForConfig(config)?.packageId === '@mario.andreschak/mcp-flujo');
  if (!discovery) {
    return {
      success: false,
      error: 'Quick Chat needs the FLUJO connection. Enable or restore it on the Connected apps page and try again.',
      statusCode: 400,
    };
  }
  const serverTools: Record<string, string[]> = { [discovery.name]: [...QUICK_CHAT_DISCOVERY_TOOLS] };
  // Preserve explicit integrations used by specialized callers and older API
  // clients, without loading unrelated catalogs during ordinary Quick Chat setup.
  for (const selected of selection.servers ?? []) {
    if (!enabled.some((config) => config.name === selected.name)) {
      return { success: false, error: `Unknown or disabled MCP server "${selected.name}".`, statusCode: 400 };
    }
    const listed = await mcpService.listServerTools(selected.name);
    if (listed.error) return { success: false, error: listed.error, statusCode: 503 };
    serverTools[selected.name] = listed.tools.map((tool) => tool.name);
  }
  const result = synthesizeQuickChatFlow(selection, {
    models,
    servers: enabled.map((config) => ({ name: config.name })),
    serverTools,
    discoveryServer: discovery.name,
  });

  if (!result.flow) {
    log.info(`Quick-chat synthesis rejected: ${result.error}`);
    return { success: false, error: result.error ?? 'Could not build quick chat', statusCode: 400 };
  }

  log.info(
    `Synthesized quick-chat flow ${result.flow.id} ` +
      `(${result.flow.nodes.length} nodes, ${result.flow.edges.length} edges)`
  );
  return { success: true, flow: result.flow };
}
