import React from 'react';
import { Panel } from '@xyflow/react';
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

interface CanvasToolbarProps {
  flowContainerRef: React.RefObject<HTMLDivElement>;
}

/**
 * Toolbar component for the Canvas with zoom controls
 */
export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({ flowContainerRef }) => {
  return (
    <Panel position="top-right" style={{ margin: '10px' }}>
      <div style={{ display: 'flex', gap: '5px' }}>
        <Tooltip title="Zoom In">
          <ToolbarButton 
            variant="outlined" 
            size="small"
            onClick={() => flowContainerRef.current?.querySelector<any>('.react-flow__controls-button:first-child')?.click()}
          >
            <ZoomInIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
        <Tooltip title="Zoom Out">
          <ToolbarButton 
            variant="outlined" 
            size="small"
            onClick={() => flowContainerRef.current?.querySelector<any>('.react-flow__controls-button:nth-child(2)')?.click()}
          >
            <ZoomOutIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
        <Tooltip title="Fit View">
          <ToolbarButton 
            variant="outlined" 
            size="small"
            onClick={() => flowContainerRef.current?.querySelector<any>('.react-flow__controls-button:nth-child(3)')?.click()}
          >
            <FitScreenIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
      </div>
    </Panel>
  );
};

export default CanvasToolbar;
