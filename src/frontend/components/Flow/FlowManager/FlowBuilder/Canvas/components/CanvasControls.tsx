import React from 'react';
import { Background, Controls, MiniMap } from '@xyflow/react';

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
  return (
    <>
      {showBackground && <Background />}
      {showControls && <Controls />}
      {showMiniMap && <MiniMap />}
    </>
  );
};

export default CanvasControls;
