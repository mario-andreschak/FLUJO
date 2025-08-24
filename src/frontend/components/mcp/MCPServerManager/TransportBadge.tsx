'use client';

import React from 'react';
import { Chip, Box } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import WifiIcon from '@mui/icons-material/Wifi';
import ContainerIcon from '@mui/icons-material/Inventory2';
import StreamIcon from '@mui/icons-material/Stream';
import HttpIcon from '@mui/icons-material/Http';

interface TransportBadgeProps {
  transport: 'stdio' | 'websocket' | 'docker' | 'sse' | 'streamable';
  size?: 'small' | 'medium';
}

const TransportBadge: React.FC<TransportBadgeProps> = ({ transport, size = 'small' }) => {
  const getTransportConfig = () => {
    switch (transport) {
      case 'stdio':
        return {
          label: 'STDIO',
          icon: <TerminalIcon fontSize="small" />,
          color: '#1976d2', // Blue
          bgColor: '#e3f2fd'
        };
      case 'websocket':
        return {
          label: 'WebSocket',
          icon: <WifiIcon fontSize="small" />,
          color: '#2e7d32', // Green
          bgColor: '#e8f5e8'
        };
      case 'docker':
        return {
          label: 'Docker',
          icon: <ContainerIcon fontSize="small" />,
          color: '#7b1fa2', // Purple
          bgColor: '#f3e5f5'
        };
      case 'sse':
        return {
          label: 'SSE',
          icon: <StreamIcon fontSize="small" />,
          color: '#f57c00', // Orange
          bgColor: '#fff3e0'
        };
      case 'streamable':
        return {
          label: 'HTTP Stream',
          icon: <HttpIcon fontSize="small" />,
          color: '#00796b', // Teal
          bgColor: '#e0f2f1'
        };
      default:
        return {
          label: 'UNKNOWN',
          icon: <TerminalIcon fontSize="small" />,
          color: '#757575', // Gray
          bgColor: '#f5f5f5'
        };
    }
  };

  const config = getTransportConfig();

  return (
    <Chip
      icon={config.icon}
      label={config.label}
      size={size}
      sx={{
        backgroundColor: config.bgColor,
        color: config.color,
        fontWeight: 500,
        fontSize: size === 'small' ? '0.75rem' : '0.875rem',
        height: size === 'small' ? 24 : 32,
        '& .MuiChip-icon': {
          color: config.color,
        },
      }}
    />
  );
};

export default TransportBadge;
