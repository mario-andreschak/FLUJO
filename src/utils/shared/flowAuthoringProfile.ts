import type { Flow } from '@/shared/types/flow';
import {
  getGuidedSubagentLinks,
  isCanonicalGuidedSubagent,
} from '@/utils/shared/guidedSubagents';

export type FlowAuthoringMode = 'guided' | 'advanced';

const ADVANCED_PROCESS_PROPERTIES = new Set([
  'maxTurns',
  'excludeModelPrompt',
  'excludeStartNodePrompt',
  'excludeSystemPrompt',
  'allowedTools',
  'isolatedPrompt',
  'allowCallerPrompt',
  'enableTodoTool',
  'captureVariable',
  'captureResource',
  'captureKv',
  'resourceNodes',
]);

const ADVANCED_SUBFLOW_PROPERTIES = new Set([
  'parallelSubflowIds',
  'parallelSubflowIdsVar',
  'mapOverList',
  'itemSplit',
  'sequential',
  'allowCallerFanout',
  'spawnBriefs',
  'concurrencyLimit',
  'joinSeparator',
  'errorStrategy',
  'allowCallerPrompt',
  'saveConversation',
  'captureVariable',
  'captureResource',
  'captureKv',
]);

/** True when Guided mode would hide authored behavior on this flow. */
export function flowUsesAdvancedFeatures(flow: Pick<Flow, 'nodes' | 'edges' | 'permissionRules'>): boolean {
  if (flow.permissionRules !== undefined) return true;
  const nodeById = new Map((flow.nodes ?? []).map(node => [node.id, node]));
  const guidedSubagentPairs = new Set(
    getGuidedSubagentLinks(flow.nodes ?? [], flow.edges ?? [])
      .filter(link => {
        const subflow = nodeById.get(link.subflowNodeId);
        return !!subflow && isCanonicalGuidedSubagent(subflow);
      })
      .map(link => `${link.processNodeId}\u0000${link.subflowNodeId}`),
  );
  const guidedSubagentNodeIds = new Set(
    [...guidedSubagentPairs].map(pair => pair.split('\u0000')[1]),
  );
  for (const node of flow.nodes ?? []) {
    if (!['start', 'process', 'finish', 'subflow', 'mcp'].includes(node.type ?? '')) return true;
    const properties = node.data?.properties ?? {};
    const keys = Object.keys(properties);
    if (node.type === 'process' && keys.some((key) => ADVANCED_PROCESS_PROPERTIES.has(key))) return true;
    if (node.type === 'subflow' && keys.some((key) => ADVANCED_SUBFLOW_PROPERTIES.has(key))) return true;
    if (
      node.type === 'process' &&
      (
        (properties.inputMode !== undefined && properties.inputMode !== 'full-history') ||
        (properties.outputMode !== undefined && properties.outputMode !== 'latest-message')
      )
    ) return true;
    if (
      node.type === 'subflow' &&
      (
        (properties.inputMode !== undefined && properties.inputMode !== (
          guidedSubagentNodeIds.has(node.id) ? 'isolated' : 'full-history'
        )) ||
        (properties.outputMode !== undefined && properties.outputMode !== 'final-only')
      )
    ) return true;
  }
  return (flow.edges ?? []).some((edge) => {
    const data = edge.data as Record<string, unknown> | undefined;
    if (data?.bidirectional === true) {
      const forward = `${edge.source}\u0000${edge.target}`;
      const reverse = `${edge.target}\u0000${edge.source}`;
      if (!guidedSubagentPairs.has(forward) && !guidedSubagentPairs.has(reverse)) return true;
    }
    return !!data?.condition || data?.edgeType === 'resource';
  });
}
