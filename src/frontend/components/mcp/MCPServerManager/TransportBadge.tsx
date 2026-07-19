'use client';

import React from 'react';
import { Chip, Box } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import WifiIcon from '@mui/icons-material/Wifi';
import StreamIcon from '@mui/icons-material/Stream';
import HttpIcon from '@mui/icons-material/Http';
import { useThemeUtils } from '@/frontend/utils/theme';

interface TransportBadgeProps {
  transport: 'stdio' | 'websocket' | 'sse' | 'streamable';
  size?: 'small' | 'medium';
}

const TransportBadge: React.FC<TransportBadgeProps> = ({ transport, size = 'small' }) => {
  const { colors } = useThemeUtils();
  const t = colors.domain.transport;

  const getTransportConfig = () => {
    switch (transport) {
      case 'stdio':
        return {
          label: 'STDIO',
          icon: <TerminalIcon fontSize="small" />,
          color: t.stdio.fg,
          bgColor: t.stdio.bg
        };
      case 'websocket':
        return {
          label: 'WebSocket',
          icon: <WifiIcon fontSize="small" />,
          color: t.websocket.fg,
          bgColor: t.websocket.bg
        };
      case 'sse':
        return {
          label: 'SSE',
          icon: <StreamIcon fontSize="small" />,
          color: t.sse.fg,
          bgColor: t.sse.bg
        };
      case 'streamable':
        return {
          label: 'HTTP Stream',
          icon: <HttpIcon fontSize="small" />,
          color: t.streamable.fg,
          bgColor: t.streamable.bg
        };
      default:
        return {
          label: 'UNKNOWN',
          icon: <TerminalIcon fontSize="small" />,
          color: t.default.fg,
          bgColor: t.default.bg
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
