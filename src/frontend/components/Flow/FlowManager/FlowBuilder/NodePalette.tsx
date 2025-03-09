"use client";

import React from 'react';
import { styled, useTheme } from '@mui/material/styles';
import { Paper, Typography, Box } from '@mui/material';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/NodePalette.tsx');
import { NodeType } from '@/frontend/types/flow/flow';
import ChatIcon from '@mui/icons-material/Chat';
import SettingsIcon from '@mui/icons-material/Settings';
import OutputIcon from '@mui/icons-material/Output';

const PaletteContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  width: '200px',
  height: '100%',
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

export const NodePalette = () => {
  log.debug('NodePalette: Entering component');
  const theme = useTheme();
  
  const onDragStart = (event: React.DragEvent, nodeType: NodeType) => {
    log.debug('onDragStart: Entering method', { nodeType });
    // Keep using the same data transfer type for compatibility with the drop handler
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
    
    // Add a drag image to make the drag operation more visible
    const dragPreview = document.createElement('div');
    dragPreview.innerHTML = `<div style="padding: 10px; background: white; border: 1px solid #ccc; border-radius: 4px;">${nodeType} Node</div>`;
    document.body.appendChild(dragPreview);
    
    // Set the drag image (with offset)
    try {
      event.dataTransfer.setDragImage(dragPreview, 75, 25);
    } catch (err) {
      log.error('onDragStart: Error setting drag image:', err);
    }
    
    // Clean up the temporary element after a short delay
    setTimeout(() => {
      document.body.removeChild(dragPreview);
    }, 0);
  };

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
