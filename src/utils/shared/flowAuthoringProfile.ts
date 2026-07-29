import type { Flow } from '@/shared/types/flow';

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
export function flowUsesAdvancedFeatures(flow: Pick<Flow, 'nodes' | 'edges' | 'permissionRules' | 'unattended'>): boolean {
  if (flow.unattended !== undefined || flow.permissionRules !== undefined) return true;
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
        (properties.inputMode !== undefined && properties.inputMode !== 'full-history') ||
        (properties.outputMode !== undefined && properties.outputMode !== 'final-only')
      )
    ) return true;
  }
  return (flow.edges ?? []).some((edge) => {
    const data = edge.data as Record<string, unknown> | undefined;
    return !!data?.condition || data?.bidirectional === true || data?.edgeType === 'resource';
  });
}
