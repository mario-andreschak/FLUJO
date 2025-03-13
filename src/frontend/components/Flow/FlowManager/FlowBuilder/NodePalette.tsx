"use client";

import React, { useCallback } from 'react';
import { styled, useTheme } from '@mui/material/styles';
import { Paper, Typography, Box } from '@mui/material';
import { createLogger } from '@/utils/logger';
import { NodeType } from '@/frontend/types/flow/flow';
import SettingsIcon from '@mui/icons-material/Settings';
import OutputIcon from '@mui/icons-material/Output';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/NodePalette.tsx');
// Constants for logging
const COMPONENT_NAME = 'NodePalette';

const PaletteContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  width: '200px',
  height: '80vh', // Match Canvas height
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(2),
}));

const NodeItem = styled(Paper, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: NodeType }>(({ theme, nodeType }) => ({
  padding: theme.spacing(1.5),
  minWidth: '180px',
  borderRadius: '8px',
  backgroundColor: theme.palette.background.paper,
  border: `2px solid ${
    nodeType === 'process'
      ? theme.palette.secondary.main
      : nodeType === 'finish'
      ? theme.palette.success.main
      : theme.palette.info.main
  }`,
  boxShadow: theme.shadows[2],
  transition: 'all 0.2s ease',
  cursor: 'grab',
  '&:hover': {
    boxShadow: `0 0 0 1px ${
      nodeType === 'process'
        ? theme.palette.secondary.main
        : nodeType === 'finish'
        ? theme.palette.success.main
        : theme.palette.info.main
    }, 0 3px 10px rgba(0,0,0,0.1)`
  },
  '&:active': {
    cursor: 'grabbing',
  },
}));

const NodeHeader = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: NodeType }>(({ theme, nodeType }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: `1px solid ${
    nodeType === 'process'
      ? theme.palette.secondary.light
      : nodeType === 'finish'
      ? theme.palette.success.light
      : theme.palette.info.light
  }`,
  marginBottom: theme.spacing(1),
  paddingBottom: theme.spacing(0.5),
}));

const NodeContent = styled(Box)({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

const nodeTypes: Array<{
  type: NodeType;
  label: string;
  description: string;
}> = [
  // Start node is automatically added to new flows and not available in the palette
  {
    type: 'process',
    label: 'Process Node',
    description: 'Let a LLM do your work',
  },
  {
    type: 'finish',
    label: 'Finish Node',
    description: 'End your flow here',
  },
  {
    type: 'mcp',
    label: 'MCP Node',
    description: 'Add functionality',
  },
];

// Helper function to get the appropriate icon for each node type
const getNodeIcon = (type: NodeType) => {
  switch (type) {
    case 'process':
      return <SettingsIcon color="secondary" />;
    case 'finish':
      return <OutputIcon color="success" />;
    case 'mcp':
      return <SettingsIcon color="info" />;
    default:
      return <SettingsIcon color="secondary" />;
  }
};

export const NodePalette: React.FC = () => {
  log.debug(`${COMPONENT_NAME}: Entering component`);
  const theme = useTheme();
  
  // Handle double-click on a node in the palette
  const onNodeDoubleClick = useCallback((nodeType: NodeType) => {
    log.debug(`${COMPONENT_NAME}.onNodeDoubleClick: Double-clicked on ${nodeType} node`);
    
    // Create and dispatch a custom event to notify the Canvas component
    const event = new CustomEvent('addNodeFromPalette', {
      detail: { nodeType, position: { x: 250, y: 150 } }
    });
    document.dispatchEvent(event);
    
    log.info(`${COMPONENT_NAME}.onNodeDoubleClick: Dispatched addNodeFromPalette event for ${nodeType} node`);
  }, []);
  
  const onDragStart = (event: React.DragEvent, nodeType: NodeType) => {
    log.debug(`${COMPONENT_NAME}.onDragStart: Entering method with nodeType=${nodeType}`);
    
    // Keep using the same data transfer type for compatibility with the drop handler
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
    
    // Add a drag image to make the drag operation more visible
    const dragPreview = document.createElement('div');
    dragPreview.innerHTML = `<div style="padding: 10px; background: white; border: 1px solid #ccc; border-radius: 4px;">${nodeType} Node</div>`;
    document.body.appendChild(dragPreview);
    
    log.debug(`${COMPONENT_NAME}.onDragStart: Created drag preview element`);
    
    // Set the drag image (with offset)
    try {
      event.dataTransfer.setDragImage(dragPreview, 75, 25);
      log.debug(`${COMPONENT_NAME}.onDragStart: Set drag image with offset (75, 25)`);
    } catch (err) {
      log.error(`${COMPONENT_NAME}.onDragStart: Error setting drag image:`, err);
    }
    
    // Clean up the temporary element after a short delay
    setTimeout(() => {
      document.body.removeChild(dragPreview);
      log.debug(`${COMPONENT_NAME}.onDragStart: Removed drag preview element`);
    }, 0);
    
    log.debug(`${COMPONENT_NAME}.onDragStart: Drag operation initialized`);
  };
  
  // Add handler for drag end events
  const onDragEnd = (event: React.DragEvent, nodeType: NodeType) => {
    log.debug(`${COMPONENT_NAME}.onDragEnd: Drag operation ended for nodeType=${nodeType}`);
  };

  log.debug(`${COMPONENT_NAME}: Rendering component`);
  return (
    <PaletteContainer elevation={2}>
      <Typography variant="h6" gutterBottom>
        Node Types
      </Typography>
      <Box display="flex" flexDirection="column" gap={2}>
        {nodeTypes.map((node) => (
          <NodeItem
            key={node.type}
            nodeType={node.type}
            elevation={1}
            draggable
            onDragStart={(e) => onDragStart(e, node.type)}
            onDragEnd={(e) => onDragEnd(e, node.type)}
            onDoubleClick={() => onNodeDoubleClick(node.type)}
          >
            <NodeHeader nodeType={node.type}>
              <NodeContent>
                {getNodeIcon(node.type)}
                <Typography variant="subtitle2" fontWeight="bold">
                  {node.label}
                </Typography>
              </NodeContent>
            </NodeHeader>
            <Typography variant="caption" color="text.secondary">
              {node.description}
            </Typography>
          </NodeItem>
        ))}
      </Box>
    </PaletteContainer>
  );
};

export default NodePalette;
