import { Edge } from '@xyflow/react';
import { PropertyDefinition } from './types';

// Editable per-node properties surfaced in the Process node modal.
export const getNodeProperties = (): PropertyDefinition[] => [
  {
    key: 'maxTurns',
    label: 'Max Turns (override)',
    type: 'number',
    min: 1,
    helperText:
      'Optional. Overrides the bound model\'s Max Turns for this node. Leave empty to inherit the model setting (default 50).',
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
