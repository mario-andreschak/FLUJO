"use client";

import React, { FC } from 'react';
import { 
  EdgeProps, 
  getSmoothStepPath, 
  BaseEdge, 
  EdgeLabelRenderer,
  Position
} from '@xyflow/react';
import { styled } from '@mui/material/styles';

const EdgeButton = styled('button')({
  background: 'white',
  border: '1px solid #ddd',
  cursor: 'pointer',
  borderRadius: '50%',
  fontSize: '10px',
  width: '20px',
  height: '20px',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  '&:hover': {
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
  }
});

const EdgePath = styled(BaseEdge)(({ theme }) => ({
  '&.animated': {
    strokeDasharray: 5,
    animation: 'flowPathAnimation 0.5s infinite linear',
  },
  '&.temp': {
    strokeDasharray: '5,5',
    strokeOpacity: 0.5,
  },
  '@keyframes flowPathAnimation': {
    '0%': {
      strokeDashoffset: 10,
    },
    '100%': {
      strokeDashoffset: 0,
    },
  }
}));

const CustomEdge: FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
  selected
}) => {
  // Default values for edge path
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: sourcePosition || Position.Bottom,
    targetX,
    targetY,
    targetPosition: targetPosition || Position.Top,
    borderRadius: 16
  });

  // Default edge style
  const edgeStyle = {
    ...style,
    strokeWidth: selected ? 3 : 2,
    stroke: selected ? '#1976d2' : '#555',
  };

  return (
    <>
      <EdgePath 
        path={edgePath} 
        markerEnd={markerEnd} 
        style={edgeStyle} 
        id={id}
        className={data?.animated ? 'animated' : ''}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            zIndex: 1000,
          }}
          className="nodrag nopan"
        >
          <EdgeButton title="Delete connection">×</EdgeButton>
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

export default CustomEdge;
