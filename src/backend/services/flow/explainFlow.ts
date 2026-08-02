import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Wave, WaveChainEdge, WaveChainNode } from '@/shared/types/waves/waves';
import type { WaveSubflowRef } from '@/shared/types/waves/waves';
import { formatConditionLabel, type EdgeCondition } from '@/utils/shared/edgeConditions';
import { resolveWaves, type WaveResolverExecutionEntry } from '@/backend/services/waves/waveResolver';
import { directSubflowIds, reachableTopics } from '@/shared/utils/signalTopics';

type EdgeData = {
  edgeType?: string;
  bidirectional?: boolean;
  condition?: EdgeCondition;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const nodeType = (node: FlowNode): string => text(node.data?.type) || text(node.type) || 'unknown';
const nodeLabel = (node: FlowNode): string => text(node.data?.label) || text(node.data?.properties?.name) || nodeType(node);

function oneLine(value: unknown, max = 180): string {
  const compact = text(value).replace(/\s+/g, ' ');
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function quoteList(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}

function controlEdges(flow: Flow): Edge[] {
  return flow.edges.filter((edge) => {
    const kind = (edge.data as EdgeData | undefined)?.edgeType;
    return kind !== 'mcp' && kind !== 'resource';
  });
}

/** Stable execution order: traverse from start nodes, then include disconnected nodes. */
function orderedExecutionNodes(flow: Flow): FlowNode[] {
  const executable = flow.nodes.filter((node) => !['mcp', 'resource'].includes(nodeType(node)));
  const byId = new Map(executable.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map(executable.map((node) => [node.id, 0]));
  for (const edge of controlEdges(flow)) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source)!.push(edge.target);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }
  const starts = executable.filter((node) => nodeType(node) === 'start');
  const roots = starts.length > 0
    ? starts
    : executable.filter((node) => (incomingCount.get(node.id) ?? 0) === 0);
  const queue = roots.map((node) => node.id);
  const seen = new Set<string>();
  const ordered: FlowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const target of outgoing.get(id) ?? []) queue.push(target);
  }
  for (const node of executable) if (!seen.has(node.id)) ordered.push(node);
  return ordered;
}

function describeInputMode(mode: unknown): string {
  if (mode === 'isolated') return 'runs with an isolated authored/caller-supplied prompt, without parent history';
  if (mode === 'latest-message') return 'receives the latest user/assistant exchange';
  return 'receives the full conversation history';
}

function describeSubflow(node: FlowNode, flowsById: Map<string, Flow>): string[] {
  const props = node.data?.properties ?? {};
  const primaryId = text(props.subflowId);
  const staticIds = Array.isArray(props.parallelSubflowIds)
    ? props.parallelSubflowIds.filter((id: unknown): id is string => typeof id === 'string' && !!id.trim())
    : [];
  const ids = [...new Set([primaryId, ...staticIds].filter(Boolean))];
  const names = ids.map((id) => flowsById.get(id)?.name ? `"${flowsById.get(id)!.name}" (${id})` : `missing flow ${id}`);
  const lines: string[] = [];
  if (names.length > 0) lines.push(`Invokes ${names.join(', ')}; it ${describeInputMode(props.inputMode)}.`);
  else lines.push('Its target is selected dynamically at runtime or is currently unresolved.');

  const concurrency = typeof props.concurrencyLimit === 'number'
    ? Math.max(1, Math.floor(props.concurrencyLimit))
    : 4;
  lines.push(`Each visit is an ordered child-job queue with at most ${concurrency} active ${concurrency === 1 ? 'child' : 'children'}; additional jobs wait until a worker is available.`);
  lines.push('An upstream routing model may call this Subflow handoff any number of times, adding one optionally briefed job per call.');

  if (Array.isArray(props.spawnBriefs) && props.spawnBriefs.length > 0) {
    lines.push(`It starts ${props.spawnBriefs.length} parallel child run(s), one per authored brief.`);
  } else if (text(props.parallelSubflowIdsVar)) {
    lines.push(`The child-flow list may be chosen dynamically from run variable \`${text(props.parallelSubflowIdsVar)}\`; those children run in parallel.`);
  } else if (staticIds.length > 0) {
    lines.push(`It fans out to ${staticIds.length} child flows in parallel and joins their outputs.`);
  } else if (props.mapOverList) {
    lines.push(`It invokes the child once per ${props.itemSplit === 'lines' ? 'non-empty input line' : 'item in a JSON array'}, ${props.sequential ? 'sequentially' : `with bounded concurrency${props.concurrencyLimit ? ` (${props.concurrencyLimit})` : ''}`}, then joins the outputs.`);
  } else {
    lines.push('The referenced flow runs once for each queued job and the ordered results are folded back into the parent run.');
  }
  if (props.outputMode === 'final-only') lines.push('Only the child’s final output is shown in the parent; intermediate child steps are hidden.');
  if (props.saveConversation === false) lines.push('Child runs are ephemeral and do not create separate saved conversations.');
  else lines.push('Child runs are saved as linked conversations unless runtime mode overrides persistence.');
  if (text(props.captureVariable)) lines.push(`The joined result is captured in run variable \`${text(props.captureVariable)}\`.`);
  if (text(props.captureResource)) lines.push(`The joined result is captured as run resource \`${text(props.captureResource)}\`.`);
  if (text(props.captureKv)) lines.push(`The joined result is persisted in key-value entry \`${text(props.captureKv)}\`.`);
  return lines;
}

function attachedCapabilities(flow: Flow, node: FlowNode): string[] {
  const attachments = flow.edges.filter((edge) => {
    const kind = (edge.data as EdgeData | undefined)?.edgeType;
    return (kind === 'mcp' || kind === 'resource') && (edge.source === node.id || edge.target === node.id);
  });
  const byId = new Map(flow.nodes.map((candidate) => [candidate.id, candidate]));
  return attachments.flatMap((edge) => {
    const other = byId.get(edge.source === node.id ? edge.target : edge.source);
    if (!other) return [];
    const props = other.data?.properties ?? {};
    if (nodeType(other) === 'mcp') {
      const server = text(props.boundServer) || nodeLabel(other);
      const tools = Array.isArray(props.enabledTools) ? props.enabledTools.filter((tool: unknown): tool is string => typeof tool === 'string') : [];
      return [`MCP server \`${server}\`${tools.length > 0 ? ` (tools: ${quoteList(tools)})` : ' (all exposed tools)'}`];
    }
    if (nodeType(other) === 'resource') return [`run resource \`${text(props.runName) || nodeLabel(other)}\``];
    return [];
  });
}

function stepDetails(flow: Flow, node: FlowNode, flowsById: Map<string, Flow>): string[] {
  const type = nodeType(node);
  const props = node.data?.properties ?? {};
  const lines: string[] = [];
  if (type === 'start') {
    lines.push('Entry point for the user or trigger input.');
    if (oneLine(props.promptTemplate)) lines.push(`Adds this starting instruction: “${oneLine(props.promptTemplate)}”`);
  } else if (type === 'process') {
    lines.push(`Runs a model step${text(props.boundModel) ? ` bound to \`${text(props.boundModel)}\`` : ''}; it ${describeInputMode(props.inputMode)}.`);
    if (oneLine(props.promptTemplate)) lines.push(`Primary instruction: “${oneLine(props.promptTemplate)}”`);
    const capabilities = attachedCapabilities(flow, node);
    if (capabilities.length > 0) lines.push(`Can use ${capabilities.join('; ')}.`);
    if (props.allowQuestion) lines.push('May pause to ask the user a structured question; avoid this in unattended runs.');
    if (text(props.captureVariable)) lines.push(`Captures its final answer in run variable \`${text(props.captureVariable)}\`.`);
    if (text(props.captureResource)) lines.push(`Captures its final answer as run resource \`${text(props.captureResource)}\`.`);
    if (text(props.captureKv)) lines.push(`Persists its final answer in key-value entry \`${text(props.captureKv)}\`.`);
  } else if (type === 'subflow') {
    lines.push(...describeSubflow(node, flowsById));
  } else if (type === 'signal') {
    const topic = text(props.topic) || '(unnamed topic)';
    lines.push(`Emits signal topic \`${topic}\` immediately when execution reaches this node; this is a mid-run event, not flow completion.`);
    if (oneLine(props.payloadTemplate)) lines.push(`Its payload is rendered from: “${oneLine(props.payloadTemplate)}”`);
    lines.push('Any enabled planned execution with a matching flow-event topic can start at this point, while this flow continues along its own outgoing edge(s).');
  } else if (type === 'trigger') {
    lines.push('Represents an internal trigger/routing point in the graph.');
  } else if (type === 'finish') {
    lines.push('Terminates this path; the latest folded output becomes the flow result.');
  } else {
    lines.push(`Runs a \`${type}\` node.`);
  }
  if (oneLine(node.data?.description)) lines.push(`Author note: ${oneLine(node.data.description)}`);
  return lines;
}

function connectionLines(flow: Flow): string[] {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  return controlEdges(flow).map((edge) => {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    const data = edge.data as EdgeData | undefined;
    const condition = formatConditionLabel(data?.condition);
    const qualifier = condition
      ? ` when ${condition}`
      : data?.bidirectional ? ' (bidirectional)' : '';
    return `- “${from ? nodeLabel(from) : edge.source}” → “${to ? nodeLabel(to) : edge.target}”${qualifier}.`;
  });
}

function subflowTreeContains(refs: WaveSubflowRef[], flowId: string): boolean {
  return refs.some((ref) => ref.flowId === flowId || subflowTreeContains(ref.children, flowId));
}

function callerContext(flow: Flow, allFlows: Flow[]): string[] {
  const lines: string[] = [];
  for (const parent of allFlows) {
    if (parent.id === flow.id || !directSubflowIds(parent).includes(flow.id)) continue;
    for (const node of parent.nodes.filter((candidate) => nodeType(candidate) === 'subflow')) {
      const props = node.data?.properties ?? {};
      const ids = [text(props.subflowId), ...(Array.isArray(props.parallelSubflowIds) ? props.parallelSubflowIds.map(text) : [])];
      if (!ids.includes(flow.id)) continue;
      const mode = props.mapOverList
        ? 'once per input item'
        : Array.isArray(props.parallelSubflowIds) && props.parallelSubflowIds.includes(flow.id)
          ? 'as one lane of a parallel fan-out'
          : Array.isArray(props.spawnBriefs) && props.spawnBriefs.length > 0
            ? `once per authored brief (${props.spawnBriefs.length} possible lanes)`
            : 'as a child run';
      lines.push(`- Parent flow “${parent.name}” invokes this flow ${mode} at subflow step “${nodeLabel(node)}”; it ${describeInputMode(props.inputMode)}.`);
    }
  }
  return lines;
}

function waveContext(flow: Flow, allFlows: Flow[], waves: Wave[], orphans: WaveChainNode[]): string[] {
  const lines: string[] = [];
  const flowsById = new Map(allFlows.map((candidate) => [candidate.id, candidate]));
  const emittedTopics = reachableTopics(flow.id, flowsById);
  for (const wave of waves) {
    const own = wave.nodes.filter((node) => node.flowId === flow.id);
    const indirect = wave.nodes.filter((node) => node.flowId !== flow.id && subflowTreeContains(node.subflows, flow.id));
    if (own.length === 0 && indirect.length === 0) continue;
    const byExecution = new Map(wave.nodes.map((node) => [node.executionId, node]));
    for (const node of own) {
      const timing = node.timing.mode === 'timeline'
        ? `${node.triggerKind}${node.timing.cron ? ` on \`${node.timing.cron}\`` : ''}`
        : node.timing.mode === 'fixed'
          ? node.triggerKind
          : `${node.timing.via === 'signal' ? `signal \`${node.timing.topic ?? ''}\`` : 'upstream completion'}`;
      lines.push(`- Planned execution “${node.name}” (${node.enabled ? 'enabled' : 'disabled'}) invokes this flow via ${timing} in wave \`${wave.id}\`.`);
      const incoming = wave.edges.filter((edge) => edge.toExecutionId === node.executionId);
      const outgoing = wave.edges.filter((edge) => edge.fromExecutionId === node.executionId);
      lines.push(...incoming.map((edge) => describeWaveEdge(edge, byExecution, 'incoming')));
      lines.push(...outgoing.map((edge) => describeWaveEdge(edge, byExecution, 'outgoing')));
    }
    for (const node of indirect) {
      lines.push(`- Planned execution “${node.name}” can invoke this flow indirectly as a subflow of “${node.flowName ?? node.flowId}” in wave \`${wave.id}\`.`);
      for (const edge of wave.edges.filter((candidate) =>
        candidate.fromExecutionId === node.executionId
        && candidate.via === 'signal'
        && !!candidate.topic
        && emittedTopics.has(candidate.topic))) {
        lines.push(`  - This flow’s signal \`${edge.topic}\` can cause that wave node to start “${byExecution.get(edge.toExecutionId)?.name ?? edge.toExecutionId}”.`);
      }
    }
    if (wave.hasCycle) lines.push(`- Wave \`${wave.id}\` contains a trigger cycle; runtime chain-depth and cooldown/overlap guards are what prevent unbounded event recursion.`);
  }
  for (const orphan of orphans.filter((node) => node.flowId === flow.id)) {
    lines.push(`- Planned execution “${orphan.name}” is an orphaned flow-event trigger: Waves found no matching producer, so it will not fire until its source is made resolvable.`);
  }
  return lines;
}

function describeWaveEdge(edge: WaveChainEdge, byExecution: Map<string, WaveChainNode>, direction: 'incoming' | 'outgoing'): string {
  const otherId = direction === 'incoming' ? edge.fromExecutionId : edge.toExecutionId;
  const other = byExecution.get(otherId);
  const relation = direction === 'incoming' ? 'is started by' : 'can start';
  const event = edge.via === 'signal'
    ? `signal \`${edge.topic ?? ''}\``
    : `completion${edge.on?.length ? ` (${edge.on.join(' or ')})` : ''}`;
  return `  - It ${relation} ${event} ${direction === 'incoming' ? 'from' : 'and then invoke'} “${other?.name ?? otherId}”.`;
}

/** Build a deterministic, model-readable explanation of a compiled flow and its Waves context. */
export function explainCompiledFlow(
  flow: Flow,
  allFlows: Flow[],
  executions: WaveResolverExecutionEntry[],
): string {
  const flowsById = new Map(allFlows.map((candidate) => [candidate.id, candidate]));
  const waves = resolveWaves({ executions, flows: allFlows });
  const ordered = orderedExecutionNodes(flow);
  const lines: string[] = [
    `# ${flow.name}`,
    '',
    flow.description?.trim() || `This flow contains ${ordered.length} executable step(s).`,
    '',
    '## Steps',
    '',
  ];
  ordered.forEach((node, index) => {
    lines.push(`${index + 1}. **${nodeLabel(node)}** (\`${nodeType(node)}\`)`);
    for (const detail of stepDetails(flow, node, flowsById)) lines.push(`   - ${detail}`);
  });
  const connections = connectionLines(flow);
  lines.push('', '## Connections', '');
  lines.push(...(connections.length > 0 ? connections : ['- No control connections are defined.']));
  const context = [...callerContext(flow, allFlows), ...waveContext(flow, allFlows, waves.waves, waves.orphans)];
  lines.push('', '## Invocation and Waves implications', '');
  lines.push(...(context.length > 0
    ? context
    : ['- No planned execution currently invokes this flow or links it into a Wave. It can still be run manually, through `execute_flow`, as an MCP flow tool, or as a subflow.']));
  return lines.join('\n');
}
