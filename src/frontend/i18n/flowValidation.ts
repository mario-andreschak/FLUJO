import type { Translator } from './core';
import type { TranslationKey } from './messages';

export interface LocalizableFlowIssue {
  code: string;
  message: string;
  nodeId?: string;
  nodeLabel?: string;
}

const issueMessageKeys: Record<string, TranslationKey> = {
  'no-start-node': 'validation.noStart',
  'multiple-start-nodes': 'validation.multipleStart',
  'no-finish-node': 'validation.noFinish',
  'process-missing-model': 'validation.processNoModel',
  'process-model-missing': 'validation.processModelMissing',
  'mcp-missing-server': 'validation.mcpNoServer',
  'mcp-server-missing': 'validation.serverMissing',
  'mcp-server-disconnected': 'validation.serverDisconnected',
  'mcp-node-unconnected': 'validation.nodeUnconnected',
  'resource-missing-binding': 'validation.resourceIncomplete',
  'resource-run-name': 'validation.invalidName',
  'resource-server-missing': 'validation.serverMissing',
  'resource-node-unconnected': 'validation.nodeUnconnected',
  'resource-produce-static': 'validation.staticResourceProduced',
  'resource-multiple-producers': 'validation.multipleProducers',
  'resource-consumed-never-produced': 'validation.neverProduced',
  'signal-missing-topic': 'validation.signalNoTopic',
  'start-no-outgoing': 'validation.startNoOutgoing',
  'unreachable-node': 'validation.unreachable',
  'subflow-multiple-outgoing': 'validation.subflowOneOutgoing',
  'subflow-both-targets': 'validation.incompatibleOptions',
  'subflow-map-and-parallel': 'validation.incompatibleOptions',
  'subflow-map-no-child': 'validation.subflowNoChild',
  'subflow-spawn-no-child': 'validation.subflowNoChild',
  'subflow-spawn-and-parallel': 'validation.incompatibleOptions',
  'subflow-spawn-and-map': 'validation.incompatibleOptions',
  'subflow-parallel-var-name': 'validation.invalidName',
  'subflow-map-and-parallel-var': 'validation.incompatibleOptions',
  'subflow-parallel-var-uncaptured': 'validation.dynamicTargetsMissing',
  'subflow-map-and-caller-fanout': 'validation.incompatibleOptions',
  'subflow-concurrency-limit': 'validation.concurrency',
  'edge-condition-non-process': 'validation.conditionWrongNode',
  'edge-condition-kind': 'validation.invalidCondition',
  'edge-condition-value': 'validation.invalidCondition',
  'edge-condition-regex': 'validation.invalidCondition',
  'edge-condition-no-fallback': 'validation.noFallback',
  'capture-var-name': 'validation.invalidName',
  'var-ref-uncaptured': 'validation.missingReference',
  'capture-kv-name': 'validation.invalidName',
  'kv-ref-name': 'validation.invalidName',
  'handoff-pill-obsolete': 'validation.handoffObsolete',
  'tool-pill-disconnected': 'validation.toolDisconnected',
  'tool-unavailable': 'validation.toolUnavailable',
  'handoff-target-unreferenced': 'validation.handoffUnused',
  'mcp-server-no-tools': 'validation.serverNoTools',
  'static-invalid-injectonce': 'validation.staticInjectOnce',
};

export function localizeFlowIssue(issue: LocalizableFlowIssue, t: Translator): string {
  const key = issueMessageKeys[issue.code];
  if (!key) return issue.message;
  return t(key, { node: issue.nodeLabel ?? issue.nodeId ?? '' });
}
