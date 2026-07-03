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
    /**
     * Adds an MCP node bound to the given server to the flow and connects it
     * to this Process node — the connect-a-server shortcut in the Server
     * Tools tab, so the user doesn't have to leave the modal to wire up
     * tools.
     */
    onConnectMcpServer?: (serverName: string) => void;
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
