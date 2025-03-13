import { FlowNode, NodeType } from '@/frontend/types/flow/flow';
import { 
  Edge, 
  NodeChange, 
  EdgeChange, 
  ReactFlowInstance,
  MarkerType
} from '@xyflow/react';

export interface CanvasProps {
  initialNodes?: FlowNode[];
  initialEdges?: Edge[];
  onNodesChange?: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange?: (changes: EdgeChange[]) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onInit?: (reactFlowInstance: ReactFlowInstance) => void;
  reactFlowWrapper?: React.RefObject<HTMLDivElement | null>;
  onEditNode?: (node: FlowNode) => void;
}

export interface EditNodeEventDetail {
  nodeId: string;
}

export interface NodeSelectionModalProps {
  open: boolean;
  position: { x: number; y: number } | null;
  onClose: () => void;
  onSelectNodeType: (nodeType: NodeType, position: { x: number; y: number }) => void;
  sourceNodeType?: NodeType;
  sourceHandleId?: string;
}

export interface ContextMenuState {
  open: boolean;
  position: { x: number; y: number };
  nodeId?: string;
  edgeId?: string;
}

export interface SelectedElementsState {
  nodes: string[];
  edges: string[];
}

// Constants
export const MIN_DISTANCE = 150;

// Default edge options
export const defaultEdgeOptions = {
  type: 'custom',
  animated: true,
  style: { stroke: '#555', strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 20,
    height: 20,
    color: '#555',
  },
};

// MCP edge options - bi-directional arrows without animation
export const mcpEdgeOptions = {
  type: 'mcpEdge',
  animated: false,
  style: { stroke: '#1976d2', strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 20,
    height: 20,
    color: '#1976d2',
  },
  markerStart: {
    type: MarkerType.ArrowClosed,
    width: 20,
    height: 20,
    color: '#1976d2',
  },
};
