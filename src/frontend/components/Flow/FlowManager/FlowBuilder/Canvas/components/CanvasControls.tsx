import React from 'react';
import { Background, Controls, MiniMap } from '@xyflow/react';
import { useTheme } from '@mui/material/styles';

interface CanvasControlsProps {
  showMiniMap?: boolean;
  showControls?: boolean;
  showBackground?: boolean;
}

/**
 * Component that wraps ReactFlow's Background, Controls, and MiniMap components
 */
export const CanvasControls: React.FC<CanvasControlsProps> = ({
  showMiniMap = true,
  showControls = true,
  showBackground = true,
}) => {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  
  return (
    <>
      {showBackground && (
        <Background 
          color={isDarkMode ? theme.palette.text.disabled : theme.palette.divider}
          gap={20}
          size={1}
        />
      )}
      {showControls && <Controls />}
      {showMiniMap && (
        <MiniMap 
          nodeColor={isDarkMode ? theme.palette.primary.dark : theme.palette.primary.light}
          maskColor={isDarkMode ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.6)'}
        />
      )}
    </>
  );
};

export default CanvasControls;
