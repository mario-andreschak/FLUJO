import { useState, useEffect, useCallback } from 'react';
import { FlowNode } from '@/frontend/types/flow/flow';
import type { ProcessNodeData, ProcessNodeProperties } from '../types';

const useNodeData = (node: FlowNode | null) => {
  const [nodeData, setNodeData] = useState<ProcessNodeData | null>(null);

  useEffect(() => {
    if (node) {
      setNodeData({
        id: node.id, // Include the node ID
        ...node.data,
        properties: { ...node.data.properties } as ProcessNodeProperties
      });
    }
  }, [node]);

  const handlePropertyChange = useCallback((key: string, value: unknown) => {
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
