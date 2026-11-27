import type { ToolDefinition } from '../types';
import type { ToolLoadingMode } from '@/shared/types/flow/toolLoading';

/**
 * Deferred tool descriptions (#1448).
 *
 * A step with many MCP tools used to send every tool's full JSON schema to the
 * model on every turn. With deferral the model first sees a short catalog (one
 * line per tool) inside the `search_tools` tool. It searches, FLUJO returns
 * the full descriptions of the matches, and those tools are loaded: from the
 * next turn on they are offered with their full schema like any other tool.
 *
 * Adapters that run their own tool loop inside one call (Claude subscription,
 * Codex, Antigravity) cannot add tools mid-call, so they also get `call_tool`,
 * which runs a found tool by name. Either way the call goes through the same
 * per-step tool list and the same approval gate as a direct call.
 *
 * FLUJO's own tools (handoffs, todo, read_resource, ...) are never deferred:
 * they are few, small, and the model needs them to steer the run.
 */

export const SEARCH_TOOLS_TOOL_NAME = 'search_tools';
export const CALL_TOOL_TOOL_NAME = 'call_tool';


export function isSearchToolsName(name: string): boolean {
  return name === SEARCH_TOOLS_TOOL_NAME;
}

export function isCallToolName(name: string): boolean {
  return name === CALL_TOOL_TOOL_NAME;
}

const CHARS_PER_TOKEN = 4;
/** In `auto`, defer once full MCP descriptions would fill this share of the context window. */
const AUTO_CONTEXT_SHARE = 0.05;
const AUTO_MIN_TOKENS = 2_000;
const FALLBACK_CONTEXT_TOKENS = 128 * 1024;
/** About 2,000 tokens: the catalog itself must stay small. */
export const CATALOG_BUDGET_CHARS = 8_000;
const SUMMARY_MAX_CHARS = 100;
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

/** Rough token count of tools as the model receives them (name, description, schema). */
export function toolDefinitionTokens(tools: readonly ToolDefinition[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars += JSON.stringify({ name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema ?? {} }).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The size above which `auto` defers, scaled with the model's context window. */
export function autoDeferThresholdTokens(contextWindow?: number): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_TOKENS;
  return Math.max(AUTO_MIN_TOKENS, Math.floor(window * AUTO_CONTEXT_SHARE));
}

export function shouldDeferToolDescriptions(
  mode: ToolLoadingMode,
  deferrable: readonly ToolDefinition[],
  contextWindow?: number,
): boolean {
  if (deferrable.length === 0 || mode === 'up-front') return false;
  if (mode === 'on-demand') return true;
  return toolDefinitionTokens(deferrable) > autoDeferThresholdTokens(contextWindow);
}

/** The first sentence of a description, on one line, at most 100 characters. */
export function summarizeToolDescription(description?: string): string {
  const flat = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentenceEnd = flat.search(/[.!?](\s|$)/);
  const sentence = sentenceEnd >= 0 ? flat.slice(0, sentenceEnd + 1) : flat;
  return sentence.length > SUMMARY_MAX_CHARS ? `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

function byName(a: ToolDefinition, b: ToolDefinition): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function serverOf(tool: ToolDefinition): string {
  return tool.server ? ` (${tool.server})` : '';
}

/**
 * The short catalog shown before any search: names with one-line summaries,
 * then names only, then tool counts per server, whichever fits the budget.
 * Sorted, so the same tools always give the same text (prompt cache).
 */
export function buildDeferredToolCatalog(
  tools: readonly ToolDefinition[],
  budgetChars = CATALOG_BUDGET_CHARS,
): string {
  const sorted = [...tools].sort(byName);
  const withSummaries = sorted.map((tool) => {
    const summary = summarizeToolDescription(tool.description);
    return `- ${tool.name}${serverOf(tool)}${summary ? `: ${summary}` : ''}`;
  }).join('\n');
  if (withSummaries.length <= budgetChars) return withSummaries;
  const namesOnly = sorted.map((tool) => `- ${tool.name}${serverOf(tool)}`).join('\n');
  if (namesOnly.length <= budgetChars) return namesOnly;
  const counts = new Map<string, number>();
  for (const tool of sorted) counts.set(tool.server ?? 'other', (counts.get(tool.server ?? 'other') ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([server, count]) => `- ${server}: ${count} tool${count === 1 ? '' : 's'} (search to see them)`)
    .join('\n');
}

export interface SearchToolsOptions {
  /** The adapter runs its own tool loop, so found tools are run with `call_tool`. */
  callThrough: boolean;
}

export function buildSearchToolsTool(
  catalogTools: readonly ToolDefinition[],
  options: SearchToolsOptions,
): ToolDefinition {
  const howToUse = options.callThrough
    ? `then run it with \`${CALL_TOOL_TOOL_NAME}\`.`
    : 'it is then loaded, so you can call it directly from your next step on.';
  return {
    name: SEARCH_TOOLS_TOOL_NAME,
    description:
      'This step has more tools than are described here. To keep your context small they are listed by name only. ' +
      `Before you use one, call this tool to read its full description and inputs; ${howToUse} ` +
      'Search with words that describe what you need (`query`), or load tools by their exact names (`names`).\n\n' +
      `Tools you can load:\n${buildDeferredToolCatalog(catalogTools)}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words that describe what you need, for example "create issue" or "read file".',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact tool names from the list, to load those tools directly.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `How many tools to return at most (default ${DEFAULT_SEARCH_LIMIT}).`,
        },
      },
    },
  };
}

export function buildCallToolTool(): ToolDefinition {
  return {
    name: CALL_TOOL_TOOL_NAME,
    description:
      `Run a tool you found with \`${SEARCH_TOOLS_TOOL_NAME}\`. Give its exact name and its arguments. ` +
      'It is checked and approved exactly like a direct call.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact tool name.' },
        arguments: { type: 'object', additionalProperties: true, description: 'The tool\'s arguments.' },
      },
      required: ['name'],
    },
  };
}

export interface ToolLoadingPlanInput {
  /** Every tool the step offers, after all filters. */
  tools: readonly ToolDefinition[];
  mode: ToolLoadingMode;
  /** Model-facing names already loaded on this conversation. */
  loadedNames?: readonly string[];
  contextWindow?: number;
  callThrough: boolean;
}

export interface ToolLoadingPlan {
  /** The tools sent to the model, with `search_tools` (and `call_tool`) when deferring. */
  visible: ToolDefinition[];
  /** MCP tools offered by the step whose descriptions are not sent yet. */
  deferred: ToolDefinition[];
  /** Every MCP tool the step offers, deferred or loaded. */
  mcpTools: ToolDefinition[];
  deferring: boolean;
}

/** Split a step's tools into what the model sees now and what it can load. */
export function planToolLoading(input: ToolLoadingPlanInput): ToolLoadingPlan {
  const mcpTools = input.tools.filter((tool) => Boolean(tool.server));
  if (!shouldDeferToolDescriptions(input.mode, mcpTools, input.contextWindow)) {
    return { visible: [...input.tools], deferred: [], mcpTools, deferring: false };
  }
  const loaded = new Set(input.loadedNames ?? []);
  const deferred = mcpTools.filter((tool) => !loaded.has(tool.name));
  const visible = input.tools.filter((tool) => !tool.server || loaded.has(tool.name));
  visible.push(buildSearchToolsTool(mcpTools, { callThrough: input.callThrough }));
  if (input.callThrough) visible.push(buildCallToolTool());
  return { visible, deferred, mcpTools, deferring: true };
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

export interface ToolSearchRequest {
  query?: string;
  names?: readonly string[];
  limit?: number;
}

export function normalizeToolSearchRequest(args: Record<string, unknown>): ToolSearchRequest {
  const query = typeof args.query === 'string' ? args.query : undefined;
  const names = Array.isArray(args.names) ? args.names.filter((name): name is string => typeof name === 'string') : undefined;
  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
  const limit = rawLimit === undefined ? undefined : Math.min(MAX_SEARCH_LIMIT, Math.max(1, rawLimit));
  return { query, names, limit };
}

/**
 * Exact names first, then the best keyword matches. A word in the tool's
 * name counts most, then its server, then its description.
 */
export function searchDeferredTools(
  tools: readonly ToolDefinition[],
  request: ToolSearchRequest,
): ToolDefinition[] {
  const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
  const picked: ToolDefinition[] = [];
  const seen = new Set<string>();
  const add = (tool: ToolDefinition) => {
    if (seen.has(tool.name)) return;
    seen.add(tool.name);
    picked.push(tool);
  };
  for (const wanted of request.names ?? []) {
    const lower = wanted.trim().toLowerCase();
    const exact = tools.find((tool) => tool.name.toLowerCase() === lower)
      ?? tools.find((tool) => (tool.originalName ?? '').toLowerCase() === lower);
    if (exact) add(exact);
  }
  const queryWords = [...new Set(words(request.query ?? ''))];
  if (queryWords.length > 0) {
    const phrase = queryWords.join(' ');
    const scored = tools.map((tool) => {
      const nameWords = new Set([...words(tool.name), ...words(tool.originalName ?? '')]);
      const serverWords = new Set(words(tool.server ?? ''));
      const descriptionWords = words(tool.description ?? '');
      let score = 0;
      for (const word of queryWords) {
        if (nameWords.has(word)) score += 4;
        else if ([...nameWords].some((name) => name.startsWith(word) || word.startsWith(name))) score += 2;
        if (serverWords.has(word)) score += 2;
        score += Math.min(3, descriptionWords.filter((entry) => entry === word).length);
      }
      if (words(tool.originalName ?? tool.name).join(' ').includes(phrase)) score += 3;
      return { tool, score };
    }).filter((entry) => entry.score > 0);
    scored.sort((a, b) => b.score - a.score || byName(a.tool, b.tool));
    for (const entry of scored) add(entry.tool);
  }
  return picked.slice(0, limit);
}
