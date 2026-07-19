import { createLogger } from '@/utils/logger';
import { writeRunResource } from '@/backend/services/runResources';
import { ToolDefinition, ResourceNodeReference } from '../types';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';

/**
 * Run-resource tools (Tier 3, issue #161).
 *
 * The produce side of a resource node used to be a PASSIVE capture of the
 * process node's final assistant text (ProcessNode.post → captureResource).
 * In a multi-node flow the first step usually HANDS OFF, so its final content
 * is empty and the capture wrote an empty artifact — the reported "artifacts
 * don't work" bug. The passive path was removed in favour of an EXPLICIT
 * `write_resource` tool: when a PRODUCE-role run-artifact resource node is
 * wired to a step, the step's model is given a tool it can call to write the
 * artifact's real content, matching how a model actually behaves when asked to
 * "produce an artifact".
 *
 * The tool is only OFFERED when such a node is wired (mirrors how mcpNodes gate
 * MCP tools), so byte-identical prompts/tools survive for flows that don't use
 * resources (preserving the #89 provider prefix-cache stability). External /
 * MCP-provided resources stay read-only — this only writes run-scoped artifacts
 * owned by the current conversation.
 *
 * Both tool-loop implementations use this module: the request/response path
 * (ModelHandler.processToolCalls) intercepts the tool by name and calls
 * `executeRunResourceTool`; the self-orchestrating Claude-subscription adapter
 * receives a `localToolExecutors` entry built from the same function.
 */

const log = createLogger('backend/flow/execution/handlers/runResourceTools');

export const WRITE_RESOURCE_TOOL_NAME = 'write_resource';

/** True for any synthetic run-resource tool (dispatched here, not via mcpService). */
export function isRunResourceToolName(name: string): boolean {
  return name === WRITE_RESOURCE_TOOL_NAME;
}

/**
 * Synthesize the run-resource tool definitions for a step from the resource
 * nodes FlowConverter folded onto it. Only PRODUCE-role run artifacts (scope
 * 'run' with a runName) yield a `write_resource` tool. Returns [] when nothing
 * is wired, so a step without a produce node is byte-identical to before.
 */
export function buildRunResourceTools(
  resourceNodes: ResourceNodeReference[] | undefined,
): ToolDefinition[] {
  const produce = (resourceNodes ?? []).filter(
    (r) => r.role === 'produce' && r.properties?.scope === 'run' && !!r.properties?.runName?.trim(),
  );
  if (produce.length === 0) return [];

  // De-dupe names (two produce edges could target the same artifact name).
  const names = Array.from(new Set(produce.map((r) => r.properties!.runName!.trim())));
  const quoted = names.map((n) => `"${n}"`).join(', ');

  return [{
    name: WRITE_RESOURCE_TOOL_NAME,
    description:
      'Produce/update a run artifact — a named data output of this flow run that later steps can read via ' +
      '${res:NAME} and that appears in the run-data panel. Write the artifact\'s FULL content here rather than ' +
      `only describing it in your reply. This step is wired to produce: ${quoted}. ` +
      'Writing the same name again replaces the previous content (last write wins).',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `The artifact name to write. Use one of: ${names.join(', ')}.`,
        },
        content: {
          type: 'string',
          description: 'The full content of the artifact (text/markdown).',
        },
      },
      required: ['name', 'content'],
    },
  }];
}

export interface RunResourceToolContext {
  /** Owning conversation — run resources are scoped to it. Absent ⇒ refused. */
  conversationId?: string;
  /** Whether this is an ephemeral (subflow-child) run — those never persist resources. */
  ephemeral?: boolean;
  /** Producing process node, recorded as lineage + carried on the emitted event. */
  node?: NodeRef;
  emit?: EmitFn;
}

export interface RunResourceToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute one run-resource tool call. Never throws — always resolves to an
 * outcome the caller turns into a tool-result message (mirroring how a real
 * MCP tool error becomes an isError result).
 */
export async function executeRunResourceTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RunResourceToolContext,
): Promise<RunResourceToolOutcome> {
  if (toolName !== WRITE_RESOURCE_TOOL_NAME) {
    return { success: false, error: `Unknown run-resource tool: ${toolName}` };
  }
  if (!ctx.conversationId || ctx.ephemeral) {
    return { success: false, error: 'Run artifacts are not available in this run.' };
  }
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { success: false, error: 'write_resource requires a non-empty "name".' };
  }
  const content = typeof args?.content === 'string' ? args.content : '';

  try {
    const written = await writeRunResource({
      conversationId: ctx.conversationId,
      name,
      mimeType: 'text/markdown',
      kind: 'text',
      data: { text: content },
      producedBy: {
        source: 'capture',
        nodeId: ctx.node?.nodeId,
        nodeName: ctx.node?.nodeName,
      },
    });
    if ('skipped' in written) {
      log.warn('write_resource skipped by store cap', { name, reason: written.skipped });
      return { success: false, error: `Artifact not stored (${written.skipped}).` };
    }
    ctx.emit?.({
      type: 'resource:write',
      node: ctx.node,
      server: 'flujo',
      uri: written.uri,
      name,
      mimeType: written.mimeType,
      size: written.size,
      source: 'capture',
    });
    log.info('write_resource stored run artifact', { name, uri: written.uri, size: written.size });
    return { success: true, data: { written: true, name, uri: written.uri, size: written.size } };
  } catch (error) {
    log.error('write_resource failed', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
