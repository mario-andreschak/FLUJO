import { Edge } from '@xyflow/react';
import { PropertyDefinition } from './types';

// No properties since we removed operation and enabled
export const getNodeProperties = (): PropertyDefinition[] => [];

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
