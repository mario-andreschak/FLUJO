import type { Flow } from '@/shared/types/flow';
import { hashFlowExecutionSnapshot } from '@/backend/services/flow/executionSnapshot';
import type { BankingPolicy } from './policy';
import { bankingToolNames } from './authority';
import { BankingError } from './errors';

/** Only synchronous, vetted inquiry graphs. No shell/files, shared memory or detached children. */
export function assertBankingGraph(flow: Flow, policy: BankingPolicy): void {
  if (flow.id !== policy.flowId || hashFlowExecutionSnapshot(flow) !== policy.graphHash) {
    throw new BankingError('approved_banking_graph_required');
  }
  const serialized = JSON.stringify(flow);
  if (/\$\{(?:kv|global|resource|res|var):|@(?:resource|conversation)\[|@conversation\.(?!id\b)/i.test(serialized)) {
    throw new BankingError('shared_data_reference_forbidden');
  }
  for (const node of flow.nodes) {
    const kind = node.data?.type ?? node.type;
    if (!['start', 'process', 'static', 'mcp', 'finish'].includes(kind ?? '')) {
      throw new BankingError('banking_graph_feature_forbidden');
    }
    const props = node.data?.properties ?? {};
    const configured = (value: unknown) => Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value);
    if (['captureKv', 'resourceNodes', 'personaTools', 'allowQuestion', 'behaviorTools', 'requireApproval',
      'mcpSkillSelections', 'fsRoots', 'roots', 'subflowId', 'detached', 'enabledResources', 'enabledPrompts',
      'enabledSkills'].some(name => configured(props[name]))) {
      throw new BankingError('banking_graph_feature_forbidden');
    }
    if (kind === 'mcp') {
      if (props.boundServer !== policy.bankServerName || !Array.isArray(props.enabledTools)
        || props.enabledTools.some(tool => typeof tool !== 'string' || !bankingToolNames.includes(tool))) {
        throw new BankingError('banking_graph_server_forbidden');
      }
      if (props.toolPresets && /(?:customer_id|session_id|assertion|authorization|_meta)/i.test(JSON.stringify(props.toolPresets))) {
        throw new BankingError('banking_graph_authority_field_forbidden');
      }
    }
    if (kind === 'static') {
      for (const entry of (Array.isArray(props.entries) ? props.entries : [])) {
        if (entry.kind === 'toolCall' && (entry.executionMode !== 'real'
          || entry.serverName !== policy.bankServerName || !bankingToolNames.includes(entry.toolName))) {
          throw new BankingError('banking_graph_tool_forbidden');
        }
        if (entry.role && !['user', 'assistant', 'system'].includes(entry.role)) {
          throw new BankingError('banking_graph_role_forbidden');
        }
      }
    }
  }
}
