import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import { Model as SharedModel } from '@/shared/types/model';

// Re-export the shared Model type
export type Model = SharedModel;

export interface ProcessNodePropertiesModalProps {
    open: boolean;
    node: FlowNode | null;
    onClose: () => void;
    onSave: (nodeId: string, data: ProcessNodeData) => void;
    flowEdges?: Edge[];
    flowNodes?: FlowNode[];
    flowId?: string; // Added flowId property
}

export interface ProcessNodeData {
    label: string;
    type: string;
    description?: string;
    properties: Record<string, unknown>;
}

export interface PropertyDefinition {
    key: string;
    label: string;
    type: 'text' | 'number' | 'select' | 'boolean';
    multiline?: boolean;
    rows?: number;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}
