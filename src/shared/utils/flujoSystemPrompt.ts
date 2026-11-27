/**
 * FLUJO's own part of a step's system prompt.
 *
 * It is a few short sections. Each one is added only when the step can really
 * use what it describes, so a model is never told about a tool it does not
 * have. Authors drop single sections per step with
 * `excludeSystemPromptSections`, or all of them with `excludeSystemPrompt`.
 * The author's own prompts are never changed; the first sentence tells the
 * model that they take priority.
 *
 * The runtime passes the exact tools it offers. Design-time previews pass
 * {@link estimateFlujoSystemPromptContext}, which reads the flow graph.
 * Pure: no I/O, so the same text is produced everywhere.
 */
import {
  HANDOFF_TOOL_PREFIX,
  SUBFLOW_TOOL_PREFIX,
  buildHandoffToolNameMap,
  buildSubflowToolNameMap,
} from './handoffNaming';

export const FLUJO_SYSTEM_PROMPT_HEADING = '# GENERAL INFORMATION:';

/**
 * Stands in for FLUJO's sections in a rendered prompt until the run knows
 * its tools. It contains NUL, so no authored prompt or reference resolver
 * produces or changes it; {@link fillFlujoSystemSections} always removes it.
 */
export const FLUJO_SYSTEM_SECTIONS_SLOT = '\u0000flujo-system-sections\u0000';

/** Put the finished sections (or nothing) where the slot is. */
export function fillFlujoSystemSections(prompt: string, sections: string): string {
  return prompt.split(FLUJO_SYSTEM_SECTIONS_SLOT).join(sections);
}

export const FLUJO_SYSTEM_PROMPT_SECTION_IDS = [
  'basics',
  'workflow',
  'agents',
  'people',
  'flujoTools',
  'storedResults',
] as const;

export type FlujoSystemPromptSectionId = (typeof FLUJO_SYSTEM_PROMPT_SECTION_IDS)[number];

/** A tool as the model sees it. */
export interface FlujoPromptTool {
  /** The name the model calls. */
  name: string;
  /** The tool's name on its MCP server. Absent for FLUJO's built-in tools. */
  originalName?: string;
  /** The MCP server that serves the tool. Absent for FLUJO's built-in tools. */
  server?: string;
}

export interface FlujoPromptHandoff {
  /** The `handoff_to_…` tool name. */
  name: string;
  /** Node type of the step it leads to (`process`, `finish`, `human`, …). */
  targetType: string;
}

export interface FlujoSystemPromptContext {
  tools: readonly FlujoPromptTool[];
  handoffs: readonly FlujoPromptHandoff[];
  /** Another agent started this run and receives its final answer. */
  startedByAgent: boolean;
}

const START_SUBFLOW_PREFIX = 'start_subflow_';
const AGENT_STEP_TYPES = new Set(['process', 'subflow']);
const MAX_LISTED_NAMES = 4;

/** Keep only known section ids, once each, in their fixed order. */
export function normalizeExcludedSystemPromptSections(value: unknown): FlujoSystemPromptSectionId[] {
  if (!Array.isArray(value)) return [];
  return FLUJO_SYSTEM_PROMPT_SECTION_IDS.filter((id) => value.includes(id));
}

function code(name: string): string {
  return `\`${name}\``;
}

/** "`a`, `b` or `c`", shortened to "`a`, `b`, `c`, `d` or 2 more". */
function nameList(names: readonly string[], conjunction = 'or'): string {
  const shown = names.slice(0, MAX_LISTED_NAMES).map(code);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} ${conjunction} ${more} more`;
  return shown.length > 1
    ? `${shown.slice(0, -1).join(', ')} ${conjunction} ${shown[shown.length - 1]}`
    : shown.join('');
}

/** "Lead: `a` does x, `b` does y." for the tools that are present. */
function toolLine(lead: string, phrases: readonly [string | undefined, string][]): string | undefined {
  const present = phrases.filter((entry): entry is [string, string] => Boolean(entry[0]));
  if (present.length === 0) return undefined;
  return `- ${lead}: ${present.map(([name, phrase]) => `${code(name)} ${phrase}`).join(', ')}.`;
}

function bullets(lines: readonly (string | undefined)[]): string[] {
  return lines.filter((line): line is string => Boolean(line));
}

function finder(tools: readonly FlujoPromptTool[]) {
  return {
    own: (name: string) => tools.find((tool) => !tool.server && tool.name === name)?.name,
    ownPrefixed: (prefix: string) => tools
      .filter((tool) => !tool.server && tool.name.startsWith(prefix))
      .map((tool) => tool.name),
    served: (originalName: string) => tools
      .find((tool) => tool.server && (tool.originalName ?? tool.name) === originalName)?.name,
    any: tools.length > 0,
  };
}

type Finder = ReturnType<typeof finder>;

function basics(context: FlujoSystemPromptContext, find: Finder): string[] {
  return [
    'You are an AI agent in FLUJO. The flow author\'s instructions take priority over this section.',
    'Answer the current user request, then stop. Do not invent future user messages, observations or review rounds. If processing returns to you in a loop, use the latest actual input and completed-action evidence; do not repeat completed actions.',
    'For a requested identifier, select the exact ID field from its source record. Match the record to the requested entity and preserve the field\'s value and type. Return a full record only when requested.',
    ...(find.any || context.handoffs.length > 0 ? ['You may do multiple tool calls.'] : []),
  ];
}

function workflow(context: FlujoSystemPromptContext): string[] {
  if (context.handoffs.length === 0) return [];
  const otherAgents = context.handoffs.some((handoff) => AGENT_STEP_TYPES.has(handoff.targetType));
  const finish = context.handoffs.some((handoff) => handoff.targetType === 'finish');
  const onlyFinish = context.handoffs.every((handoff) => handoff.targetType === 'finish');
  return [
    '## Workflow',
    ...bullets([
      otherAgents
        ? '- You are one step in a workflow with other agents, each with its own job. The user\'s message may include work for other steps: do the part you can do with your tools.'
        : undefined,
      onlyFinish
        ? undefined
        : `- When your part is done, you can hand off with ${nameList(context.handoffs.map((handoff) => handoff.name))}.`,
      finish
        ? '- When a user requests an answer, provide the requested response before handing off to Finish, in the requested format. A Finish handoff alone is not an answer.'
        : undefined,
    ]),
  ];
}

function agents(context: FlujoSystemPromptContext, find: Finder): string[] {
  const calls = find.ownPrefixed(SUBFLOW_TOOL_PREFIX);
  const starts = find.ownPrefixed(START_SUBFLOW_PREFIX);
  const send = find.own('subflow_send_message');
  const lines = bullets([
    calls.length > 0 ? `- Run a sub-agent and wait for its result: ${nameList(calls)}.` : undefined,
    starts.length > 0 ? `- Start a sub-agent in the background and keep working: ${nameList(starts)}.` : undefined,
    calls.length + starts.length > 0
      ? '- Give each sub-agent a complete task. Use sub-agents for separate or parallel work; do small tasks yourself.'
      : undefined,
    toolLine('Background work', [
      [find.own('subflow_task_get'), 'shows its status and result'],
      [find.own('subflow_task_cancel'), 'stops it'],
    ]),
    toolLine('Talk with your parent and child agents', [
      [find.own('subflow_list'), 'lists them'],
      [send, 'sends one a message'],
      [find.own('subflow_wait'), 'waits for a reply or result (instead of polling)'],
    ]),
    context.startedByAgent
      ? `- Another agent started you and receives your final answer.${send ? ` To ask it something or report progress before you finish, use ${code(send)} with target "parent".` : ''}`
      : undefined,
  ]);
  return lines.length > 0 ? ['## Other agents', ...lines] : [];
}

function people(context: FlujoSystemPromptContext, find: Finder): string[] {
  const question = find.own('question');
  const humanSteps = context.handoffs
    .filter((handoff) => handoff.targetType === 'human')
    .map((handoff) => handoff.name);
  const ticket = find.served('create_ticket_for_human');
  const lines = bullets([
    question
      ? `- When you need the user to decide something, ask with ${code(question)} and continue with the answer, instead of guessing or ending your turn.`
      : undefined,
    humanSteps.length > 0
      ? `- Hand the work to a person and wait for their answer: ${nameList(humanSteps)}.`
      : undefined,
    ticket ? `- Leave a ticket for a person without waiting for an answer: ${code(ticket)}.` : undefined,
  ]);
  return lines.length > 0 ? ['## People', ...lines] : [];
}

function flujoTools(find: Finder): string[] {
  const search = find.own('search_tools');
  const callTool = find.own('call_tool');
  const script = find.own('run_tool_script');
  const lines = bullets([
    search
      ? `- Some of your tools are listed by name only. Read a tool's description with ${code(search)} before you use it${callTool ? `, then run it with ${code(callTool)}` : ''}.`
      : undefined,
    script
      ? `- To chain several tool calls, loop over items or filter a large result, write a short program with ${code(script)}. Only what it returns comes back to you.`
      : undefined,
    toolLine('Missing a tool', [
      [find.served('discover_capabilities'), 'searches all servers and flows'],
      [find.served('list_mcp_server_tools'), 'lists a server\'s tools'],
      [find.served('call_mcp_tool'), 'calls a tool on any server'],
    ]),
    toolLine('Other conversations (earlier runs, other agents)', [
      [find.served('list_conversations'), 'lists them'],
      [find.served('read_conversation'), 'reads one'],
    ]),
    toolLine('Values kept across runs, never secrets', [
      [find.served('kv_get'), 'reads'],
      [find.served('kv_set'), 'saves'],
    ]),
    toolLine('Other agents (flows)', [
      [find.served('list_flows'), 'lists them'],
      [find.served('execute_flow'), 'runs one and returns its answer'],
    ]),
  ]);
  return lines.length > 0 ? ['## FLUJO tools', ...lines] : [];
}

function storedResults(find: Finder): string[] {
  const read = find.own('read_resource');
  return read
    ? [
        '## Stored results',
        `- A long tool result may be replaced by a \`flujo://run/…\` link. Read it with ${code(read)} instead of running the tool again.`,
      ]
    : [];
}

/** Each section's text for this context; empty when the step cannot use it. */
export function planFlujoSystemPromptSections(
  context: FlujoSystemPromptContext,
): Record<FlujoSystemPromptSectionId, string[]> {
  const find = finder(context.tools);
  return {
    basics: basics(context, find),
    workflow: workflow(context),
    agents: agents(context, find),
    people: people(context, find),
    flujoTools: flujoTools(find),
    storedResults: storedResults(find),
  };
}

/**
 * The FLUJO system prompt for one step, ending in a blank line, or '' when no
 * section applies or every applying section is excluded.
 */
export function buildFlujoSystemPrompt(
  context: FlujoSystemPromptContext,
  excludedSections: readonly FlujoSystemPromptSectionId[] = [],
): string {
  const plan = planFlujoSystemPromptSections(context);
  const blocks = FLUJO_SYSTEM_PROMPT_SECTION_IDS
    .filter((id) => !excludedSections.includes(id))
    .map((id) => plan[id].join('\n'))
    .filter(Boolean);
  return blocks.length > 0 ? `${FLUJO_SYSTEM_PROMPT_HEADING}\n${blocks.join('\n\n')}\n\n` : '';
}

interface GraphNodeLike {
  id: string;
  type?: string;
  data?: { label?: string; type?: string; properties?: Record<string, unknown> };
}

interface GraphEdgeLike {
  source: string;
  target: string;
  data?: Record<string, unknown>;
}

export interface FlowGraphLike {
  nodes: readonly GraphNodeLike[];
  edges?: readonly GraphEdgeLike[];
}

function nodeType(node: GraphNodeLike): string {
  return node.type || node.data?.type || 'unknown';
}

function isAttachmentEdge(edge: GraphEdgeLike): boolean {
  const edgeType = edge.data?.edgeType;
  return typeof edgeType === 'string' && (edgeType.includes('mcp') || edgeType === 'resource');
}

function stepTargets(flow: FlowGraphLike, nodeId: string): GraphNodeLike[] {
  const ids: string[] = [];
  for (const edge of flow.edges ?? []) {
    if (isAttachmentEdge(edge)) continue;
    if (edge.source === nodeId) ids.push(edge.target);
    else if (edge.target === nodeId && edge.data?.bidirectional === true) ids.push(edge.source);
  }
  return [...new Set(ids)]
    .map((id) => flow.nodes.find((node) => node.id === id))
    .filter((node): node is GraphNodeLike => Boolean(node))
    .filter((node) => !['mcp', 'resource'].includes(nodeType(node)));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function boundServerTools(properties: Record<string, unknown>): FlujoPromptTool[] {
  const mcpNodes = Array.isArray(properties.mcpNodes) ? properties.mcpNodes : [];
  return mcpNodes.flatMap((mcpNode) => {
    const props = record(record(mcpNode)?.properties);
    const server = typeof props?.boundServer === 'string' ? props.boundServer : undefined;
    const enabled = Array.isArray(props?.enabledTools) ? props.enabledTools : [];
    return server
      ? enabled
          .filter((tool): tool is string => typeof tool === 'string')
          .map((tool) => ({ name: tool, originalName: tool, server }))
      : [];
  });
}

/**
 * Design-time estimate of what a step can use, read from the flow graph. A
 * run knows more (tools a server lists only when connected, the agent that
 * started it), so the runtime passes its real tool list instead.
 */
export function estimateFlujoSystemPromptContext(flow: FlowGraphLike | null | undefined, nodeId: string): FlujoSystemPromptContext {
  const node = flow?.nodes.find((candidate) => candidate.id === nodeId);
  if (!flow || !node) return { tools: [], handoffs: [], startedByAgent: false };
  const properties = node.data?.properties ?? {};
  const targets = stepTargets(flow, node.id).map((target) => ({
    id: target.id,
    label: target.data?.label,
    type: nodeType(target),
  }));
  const handoffNames = buildHandoffToolNameMap(targets);
  const subflows = targets.filter((target) => target.type === 'subflow');
  const callNames = [...buildSubflowToolNameMap(subflows).values()];
  const serverTools = boundServerTools(properties);
  const resourceNodes = Array.isArray(properties.resourceNodes) ? properties.resourceNodes : [];
  const mcpNodes = Array.isArray(properties.mcpNodes) ? properties.mcpNodes : [];
  const ownTools = [
    ...callNames,
    ...callNames.map((name) => name.replace(SUBFLOW_TOOL_PREFIX, START_SUBFLOW_PREFIX)),
    ...(subflows.length > 0
      ? ['subflow_task_get', 'subflow_task_cancel', 'subflow_list', 'subflow_send_message', 'subflow_wait']
      : []),
    ...(properties.allowQuestion === true ? ['question'] : []),
    ...(mcpNodes.length > 0 || resourceNodes.length > 0 ? ['read_resource'] : []),
    // `auto` depends on the tools a server lists at run time, so only explicit settings show here.
    ...(mcpNodes.length > 0 && properties.toolLoading === 'on-demand' ? ['search_tools'] : []),
    ...(mcpNodes.length > 0 && properties.codeMode === 'on' ? ['run_tool_script'] : []),
  ];
  return {
    tools: [
      ...targets.map((target) => ({ name: handoffNames.get(target.id) ?? `${HANDOFF_TOOL_PREFIX}${target.id}` })),
      ...ownTools.map((name) => ({ name })),
      ...serverTools,
    ],
    handoffs: targets.map((target) => ({
      name: handoffNames.get(target.id) ?? `${HANDOFF_TOOL_PREFIX}${target.id}`,
      targetType: target.type,
    })),
    startedByAgent: false,
  };
}
