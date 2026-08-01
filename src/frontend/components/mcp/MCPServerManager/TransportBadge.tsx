'use client';

import React from 'react';
import { Chip, Box } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import WifiIcon from '@mui/icons-material/Wifi';
import StreamIcon from '@mui/icons-material/Stream';
import HttpIcon from '@mui/icons-material/Http';
import { useThemeUtils } from '@/frontend/utils/theme';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface TransportBadgeProps {
  transport: 'stdio' | 'websocket' | 'sse' | 'streamable';
  size?: 'small' | 'medium';
}

const TransportBadge: React.FC<TransportBadgeProps> = ({ transport, size = 'small' }) => {
  const { colors } = useThemeUtils();
  const transportColors = colors.domain.transport;
  const { t } = useI18n();

  const getTransportConfig = () => {
    switch (transport) {
      case 'stdio':
        return {
          label: t('mcp.server.transport.stdio'),
          icon: <TerminalIcon fontSize="small" />,
          color: transportColors.stdio.fg,
          bgColor: transportColors.stdio.bg
        };
      case 'websocket':
        return {
          label: t('mcp.server.transport.websocket'),
          icon: <WifiIcon fontSize="small" />,
          color: transportColors.websocket.fg,
          bgColor: transportColors.websocket.bg
        };
      case 'sse':
        return {
          label: t('mcp.server.transport.sse'),
          icon: <StreamIcon fontSize="small" />,
          color: transportColors.sse.fg,
          bgColor: transportColors.sse.bg
        };
      case 'streamable':
        return {
          label: t('mcp.server.transport.streamable'),
          icon: <HttpIcon fontSize="small" />,
          color: transportColors.streamable.fg,
          bgColor: transportColors.streamable.bg
        };
      default:
        return {
          label: t('mcp.server.unknownError'),
          icon: <TerminalIcon fontSize="small" />,
          color: transportColors.default.fg,
          bgColor: transportColors.default.bg
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
