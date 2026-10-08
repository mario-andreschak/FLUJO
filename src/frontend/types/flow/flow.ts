import type { Edge } from '@xyflow/react';
import type { FlowNode, NodeType } from '@/shared/types/flow/flow';

export type { FlowNode, NodeType } from '@/shared/types/flow/flow';

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
  /**
   * Optional user flag marking a flow as a favorite (#120). Favorites are
   * surfaced first in the Flow picker and default the "New" chat's flow.
   * Absent means "not a favorite". Frontend-only organization, migration-free
   * (mirrors `folder?` #71).
   */
  favorite?: boolean;
  personaOwnership?: {
    personaId: string;
    sourceFlowId?: string;
    groupId?: string;
    kind?: 'core' | 'role_behavior' | 'supplemental' | 'custom';
  };
  nodes: FlowNode[];
  edges: Edge[];
  input?: NodeType;
}

export interface FlowContextType {
  flows: Flow[];
  selectedFlow: Flow | null;
  addFlow: (flow: Flow) => void;
  updateFlow: (flow: Flow) => void;
  deleteFlow: (id: string) => void;
  selectFlow: (id: string) => void;
}
