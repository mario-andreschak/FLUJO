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
  /** Optional, user-authored free-text description shown on the Flow Card. */
  description?: string;
  /**
   * Optional, user-assigned folder for organizing flows on the dashboard (#71).
   * Absent/empty means "Ungrouped". Frontend-only organization.
   */
  folder?: string;
  nodes: FlowNode[];
  edges: Edge[];
  input?: NodeType;
}

export type NodeType = 'start' | 'process' | 'finish' | 'mcp' | 'subflow' | 'resource' | 'signal';

export interface FlowContextType {
  flows: Flow[];
  selectedFlow: Flow | null;
  addFlow: (flow: Flow) => void;
  updateFlow: (flow: Flow) => void;
  deleteFlow: (id: string) => void;
  selectFlow: (id: string) => void;
}
