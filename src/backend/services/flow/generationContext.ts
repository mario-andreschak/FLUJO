/**
 * Building-block context for flow authoring (issue #14 + FlowSpec-as-public-API).
 *
 * Everything a FlowSpec may reference — configured models, MCP servers and their
 * tools, existing flows as subflow targets — gathered once and offered in three
 * forms:
 *   - `blocks`: structured JSON, for the MCP `list_flow_building_blocks` tool
 *   - `catalog`: bounded human/model-readable text, folded into the generator prompt
 *   - `compile` + `validatorServers`: the shapes compileFlowSpec / validateFlow take
 *
 * Guardrails: connected servers only are asked for tools (never spawn a server to
 * introspect it — same rule as buildHandoffDescription); tool descriptions and flow
 * lists are truncated to protect the generator model's context window. `blocks`
 * carries ALL flows (agents iterate programmatically); only the rendered catalog
 * caps them.
 */
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { flowService } from '@/backend/services/flow';
import { CompileContext, CompileIssue } from '@/utils/shared/flowSpecCompiler';
import { FlowValidationIssue, FlowValidationResult } from '@/utils/shared/flowValidation';

const log = createLogger('backend/services/flow/generationContext');

/** Catalog bounds, to protect the generator model's context window. */
const MAX_TOOLS_PER_SERVER = 20;
const MAX_TOOL_DESCRIPTION_CHARS = 100;
const MAX_FLOWS_LISTED = 15;
const MAX_FLOW_DESCRIPTION_CHARS = 300;

export interface BuildingBlockModel {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
}

export interface BuildingBlockServer {
  name: string;
  connected: boolean;
  /** Present only when connected (tool names + truncated descriptions). */
  tools?: Array<{ name: string; description?: string }>;
}

export interface BuildingBlockFlow {
  id: string;
  name: string;
  description?: string;
  nodeCount: number;
}

/** The structured "what can a FlowSpec reference" answer. */
export interface BuildingBlocks {
  models: BuildingBlockModel[];
  servers: BuildingBlockServer[];
  flows: BuildingBlockFlow[];
}

export interface GenerationContext {
  blocks: BuildingBlocks;
  /** Reference-resolution context for compileFlowSpec. */
  compile: CompileContext;
  /** Bounded text catalog for the generator's system prompt. */
  catalog: string;
  /** Server status list in the shape validateFlow expects. */
  validatorServers: Array<{ name: string; status?: string }>;
}

function truncate(text: string, max: number): string {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}

/**
 * Enumerate what flow authoring may wire up. Never spawns a server: only servers
 * already connected are asked for their tools; offline ones are listed by name.
 */
export async function gatherGenerationContext(): Promise<GenerationContext> {
  const models = await modelService.loadModels();
  const blockModels: BuildingBlockModel[] = models.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.displayName ? { displayName: m.displayName } : {}),
    ...(m.description ? { description: truncate(m.description, MAX_TOOL_DESCRIPTION_CHARS) } : {}),
  }));

  const blockServers: BuildingBlockServer[] = [];
  const serverTools: Record<string, string[]> = {};
  try {
    const configs = await mcpService.loadServerConfigs();
    if (Array.isArray(configs)) {
      for (const config of configs) {
        if (config.disabled) continue;
        let connected = false;
        try {
          const status = await mcpService.getServerStatus(config.name);
          connected = status?.status === 'connected';
        } catch (error) {
          log.debug(`getServerStatus failed for ${config.name}; listing name only`, error);
        }
        if (!connected) {
          blockServers.push({ name: config.name, connected: false });
          continue;
        }
        const { tools } = await mcpService.listServerTools(config.name);
        const toolList = (tools ?? [])
          .filter((t) => t.name)
          .map((t) => ({
            name: t.name,
            ...(t.description ? { description: truncate(t.description, MAX_TOOL_DESCRIPTION_CHARS) } : {}),
          }));
        serverTools[config.name] = toolList.map((t) => t.name);
        blockServers.push({ name: config.name, connected: true, tools: toolList });
      }
    }
  } catch (error) {
    log.warn('Could not load MCP servers for the authoring context', error);
  }

  let flows: Flow[] = [];
  try {
    flows = await flowService.loadFlows();
  } catch (error) {
    log.warn('Could not load flows for the authoring context', error);
  }
  const blockFlows: BuildingBlockFlow[] = flows.map((f) => ({
    id: f.id,
    name: f.name,
    ...(f.description ? { description: truncate(f.description, MAX_FLOW_DESCRIPTION_CHARS) } : {}),
    nodeCount: f.nodes?.length ?? 0,
  }));

  const blocks: BuildingBlocks = { models: blockModels, servers: blockServers, flows: blockFlows };
  return {
    blocks,
    compile: {
      models: models.map((m) => ({ id: m.id, name: m.name, displayName: m.displayName })),
      servers: blockServers.map((s) => ({ name: s.name })),
      serverTools,
      flows: flows.map((f) => ({ id: f.id, name: f.name })),
    },
    catalog: renderCatalog(blocks),
    validatorServers: blockServers.map((s) => ({
      name: s.name,
      status: s.connected ? 'connected' : 'disconnected',
    })),
  };
}

/** Render the bounded text catalog the generator's system prompt embeds. */
export function renderCatalog(blocks: BuildingBlocks): string {
  const lines: string[] = [];

  lines.push('AVAILABLE MODELS (reference by id or name):');
  if (blocks.models.length === 0) lines.push('  (none configured)');
  for (const m of blocks.models) {
    const label = m.displayName && m.displayName !== m.name ? `"${m.displayName}" (${m.name})` : m.name;
    const desc = m.description ? ` — ${m.description}` : '';
    lines.push(`  - id: ${m.id} — ${label}${desc}`);
  }

  lines.push('', 'AVAILABLE MCP SERVERS (attach to process nodes via "servers"):');
  if (blocks.servers.length === 0) lines.push('  (none configured)');
  for (const server of blocks.servers) {
    if (!server.connected) {
      lines.push(`  - ${server.name} (offline — tools unknown; may still be used)`);
      continue;
    }
    lines.push(`  - ${server.name}:`);
    const shown = (server.tools ?? []).slice(0, MAX_TOOLS_PER_SERVER);
    for (const tool of shown) {
      const desc = tool.description ? ` — ${tool.description}` : '';
      lines.push(`      - ${tool.name}${desc}`);
    }
    const extra = (server.tools?.length ?? 0) - shown.length;
    if (extra > 0) lines.push(`      - …and ${extra} more`);
  }

  lines.push('', 'EXISTING FLOWS (usable as subflow targets via "flow"):');
  if (blocks.flows.length === 0) lines.push('  (none)');
  for (const flow of blocks.flows.slice(0, MAX_FLOWS_LISTED)) {
    const desc = flow.description ? ` — ${flow.description}` : ` — ${flow.nodeCount} nodes`;
    lines.push(`  - "${flow.name}"${desc}`);
  }
  if (blocks.flows.length > MAX_FLOWS_LISTED) {
    lines.push(`  - …and ${blocks.flows.length - MAX_FLOWS_LISTED} more`);
  }

  return lines.join('\n');
}

/** Fold compile issues into the validator's result shape (single list for callers). */
export function mergeIssues(
  compileIssues: CompileIssue[],
  validation: FlowValidationResult
): FlowValidationResult {
  const compiled: FlowValidationIssue[] = compileIssues.map((i) => ({
    severity: i.severity,
    code: i.code,
    message: i.message,
  }));
  const issues = [...compiled, ...validation.issues];
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return {
    issues,
    errorCount,
    warningCount: issues.length - errorCount,
    isRunnable: errorCount === 0,
  };
}
