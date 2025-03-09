import { useState, useEffect, useCallback } from 'react';
import { FlowNode } from '@/frontend/types/flow/flow';

const useNodeData = (node: FlowNode | null) => {
  const [nodeData, setNodeData] = useState<{
    id: string; // Add id property
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  useEffect(() => {
    if (node) {
      setNodeData({
        id: node.id, // Include the node ID
        ...node.data,
        properties: { ...node.data.properties }
      });
    }
  }, [node]);

  const handlePropertyChange = useCallback((key: string, value: any) => {
    setNodeData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        properties: {
          ...prev.properties,
          [key]: value,
        },
      };
    });
  }, []);

  return { nodeData, setNodeData, handlePropertyChange };
};

export default useNodeData;
