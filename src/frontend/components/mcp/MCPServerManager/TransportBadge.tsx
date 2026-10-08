'use client';

import React from 'react';
import { Chip, Box, Tooltip } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import WifiIcon from '@mui/icons-material/Wifi';
import StreamIcon from '@mui/icons-material/Stream';
import HttpIcon from '@mui/icons-material/Http';
import { useThemeUtils } from '@/frontend/utils/theme';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface TransportBadgeProps {
  transport: 'stdio' | 'websocket' | 'sse' | 'streamable';
  size?: 'small' | 'medium';
  /**
   * Icon-only presentation for space constrained surfaces such as the simple
   * server picker (#393). The localized transport label is still exposed via a
   * tooltip and as the accessible name, so no information is lost. Defaults to
   * false so management cards keep the labeled chip.
   */
  compact?: boolean;
}

const TransportBadge: React.FC<TransportBadgeProps> = ({ transport, size = 'small', compact = false }) => {
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

  if (compact) {
    // Non-interactive wrapper on purpose: the picker card itself is the click
    // target, so nesting a button here would break selection/keyboard behavior.
    return (
      <Tooltip title={config.label} arrow placement="top" disableInteractive>
        <Box
          component="span"
          role="img"
          tabIndex={0}
          aria-label={config.label}
          data-testid="transport-badge-compact"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: size === 'small' ? 26 : 32,
            height: size === 'small' ? 26 : 32,
            borderRadius: '50%',
            backgroundColor: config.bgColor,
            color: config.color,
            lineHeight: 0,
            outlineOffset: 2,
            '& svg': { fontSize: size === 'small' ? 17 : 20, color: 'inherit' },
          }}
        >
          {config.icon}
        </Box>
      </Tooltip>
    );
  }

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
