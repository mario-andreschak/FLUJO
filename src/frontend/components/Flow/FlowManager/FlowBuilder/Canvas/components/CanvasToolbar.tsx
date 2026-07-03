import React from 'react';
import { Panel, useReactFlow } from '@xyflow/react';
import { Button, Tooltip } from '@mui/material';
import { styled } from '@mui/material/styles';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';

const ToolbarButton = styled(Button)(({ theme }) => ({
  minWidth: '36px',
  padding: '6px',
  margin: '0 4px',
  backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.02)',
  '&:hover': {
    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)',
  }
}));

/**
 * Toolbar component for the Canvas with zoom controls, driven by the
 * ReactFlow instance API (not the Controls component's DOM).
 */
export const CanvasToolbar: React.FC = () => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel position="top-right" style={{ margin: '10px' }}>
      <div style={{ display: 'flex', gap: '5px' }}>
        <Tooltip title="Zoom In">
          <ToolbarButton variant="outlined" size="small" onClick={() => zoomIn()}>
            <ZoomInIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
        <Tooltip title="Zoom Out">
          <ToolbarButton variant="outlined" size="small" onClick={() => zoomOut()}>
            <ZoomOutIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
        <Tooltip title="Fit View">
          <ToolbarButton variant="outlined" size="small" onClick={() => fitView()}>
            <FitScreenIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
      </div>
    </Panel>
  );
};

export default CanvasToolbar;
