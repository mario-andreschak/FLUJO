import { Node, Edge } from '@xyflow/react';

export interface FlowNode extends Node {
  data: {
    label: string;
    type: string;
    description?: string;
    properties?: Record<string, any>;
  };
  selected?: boolean;
}

export interface Flow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: Edge[];
  input?: NodeType;
}

export type NodeType = 'start' | 'process' | 'finish' | 'mcp';

export interface FlowContextType {
  flows: Flow[];
  selectedFlow: Flow | null;
  addFlow: (flow: Flow) => void;
  updateFlow: (flow: Flow) => void;
  deleteFlow: (id: string) => void;
  selectFlow: (id: string) => void;
}
