import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';

export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    encryptedApiKey: string;
    baseUrl?: string;
    promptTemplate?: string;
    reasoningStartTag?: string;
    reasoningEndTag?: string;
    functionCallingSchema?: string;
}

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
