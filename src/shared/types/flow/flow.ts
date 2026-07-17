import { Node, Edge } from '@xyflow/react';

export interface HistoryEntry {
  nodes: FlowNode[];
  edges: Edge[];
}

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
   * Absent/empty means "Ungrouped". Frontend-only organization — has no effect
   * on how the flow executes.
   */
  folder?: string;
  /**
   * Optional user flag marking a flow as a favorite (#120). Favorites are
   * surfaced first in the Flow picker and default the "New" chat's flow.
   * Absent means "not a favorite". Frontend-only organization — has no effect
   * on how the flow executes.
   */
  favorite?: boolean;
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
