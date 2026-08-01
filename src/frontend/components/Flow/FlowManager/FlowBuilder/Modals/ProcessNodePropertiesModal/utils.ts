import { Edge } from '@xyflow/react';
import { PropertyDefinition } from './types';
import type { Translator } from '@/frontend/i18n/core';

// Editable per-node properties surfaced in the Process node modal.
export const getNodeProperties = (t?: Translator): PropertyDefinition[] => [
  {
    key: 'maxTurns',
    label: t ? t('flows.nodeProperties.maxTurns') : 'Maximum turns (override)',
    type: 'number',
    min: 1,
    helperText: t
      ? t('flows.nodeProperties.maxTurnsHelp')
      : 'Optional. Replaces the bound model\'s maximum turns for this node. Leave empty to inherit the model setting (default: 50).',
  },
  {
    key: 'maxTokens',
    label: t ? t('flows.nodeProperties.maxTokens') : 'Maximum output tokens (override)',
    type: 'number',
    min: 1,
    helperText: t
      ? t('flows.nodeProperties.maxTokensHelp')
      : 'Optional. Replaces the bound model\'s maximum output tokens for this node. Leave empty to inherit the adapter default. The Claude subscription adapter does not enforce this value.',
  },
];

// Find MCP nodes connected to this Process node (unique ids — there may be
// multiple edges between the same nodes)
export const findConnectedMCPNodes = (nodeId: string, allEdges: Edge[]) => {
  return [...new Set(
    allEdges
      .filter(edge =>
        (edge.source === nodeId && edge.data?.edgeType === 'mcp') ||
        (edge.target === nodeId && edge.data?.edgeType === 'mcp')
      )
      .map(edge => edge.source === nodeId ? edge.target : edge.source)
  )];
};
