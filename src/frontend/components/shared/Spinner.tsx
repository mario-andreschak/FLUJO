'use client';

import React from 'react';
import { CircularProgress, Box, SxProps, Theme } from '@mui/material';

interface SpinnerProps {
  size?: 'small' | 'medium' | 'large';
  color?: 'primary' | 'secondary' | 'white';
  className?: string;
  sx?: SxProps<Theme>;
}

/**
 * A reusable spinner component for loading states
 */
const Spinner: React.FC<SpinnerProps> = ({ 
  size = 'medium', 
  color = 'primary',
  className = '',
  sx = {}
}) => {
  // Determine size in pixels
  const sizeInPx = {
    small: 16,
    medium: 24,
    large: 36
  }[size];
  
  // Determine color for MUI
  const muiColor = color === 'white' ? 'inherit' : color;
  
  // Custom styles for white color
  const customSx = color === 'white' ? {
    color: '#fff',
    ...sx
  } : sx;

  return (
    <Box 
      component="span" 
      sx={{ 
        display: 'inline-block',
        lineHeight: 0,
        ...customSx
      }} 
      className={className}
      role="status"
    >
      <CircularProgress
        size={sizeInPx}
        color={muiColor}
        aria-hidden="true"
      />
      <Box
        component="span"
        sx={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          borderWidth: 0,
        }}
      >
        Loading...
      </Box>
    </Box>
  );
};

export default Spinner;
