"use client";

import React from 'react';
import { Box, Button, CircularProgress, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import BugReportIcon from '@mui/icons-material/BugReport';
import { useI18n } from '@/frontend/contexts/I18nContext';

/**
 * The debugger panel BEFORE there is anything to debug.
 *
 * The single Debugger button opens the panel instantly, which means the panel
 * exists in a window where no `debugState` has arrived yet:
 *
 *  - `armed`     — the conversation is idle; the next message will run in debug
 *                  mode and pause on its first node.
 *  - `attaching` — a run is already in flight; a one-shot breakpoint has been
 *                  armed and we are waiting for the loop to reach its next node.
 *
 * In both cases we show the debugger's frame with a spinner and disabled
 * controls, so the transition into the live debugger is a swap of the body
 * rather than a panel appearing out of nowhere.
 */
interface DebuggerPendingPanelProps {
  mode: 'armed' | 'attaching';
  onClose: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const DebuggerPendingPanel: React.FC<DebuggerPendingPanelProps> = ({
  mode,
  onClose,
  isExpanded,
  onToggleExpand,
}) => {
  const { t } = useI18n();

  return (
    <Paper
      elevation={0}
      square
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <BugReportIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {t('chat.debug.title')}
        </Typography>
        {onToggleExpand && (
          <Tooltip title={isExpanded ? t('chat.debug.exitFullscreen') : t('chat.debug.enterFullscreen')}>
            <IconButton
              size="small"
              onClick={onToggleExpand}
              aria-label={isExpanded ? t('chat.debug.exitFullscreen') : t('chat.debug.enterFullscreen')}
            >
              {isExpanded ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={t('chat.debug.close')}>
          <IconButton size="small" onClick={onClose} aria-label={t('chat.debug.close')}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          p: 3,
          textAlign: 'center',
        }}
        data-testid="debugger-pending"
      >
        <CircularProgress size={32} />
        <Typography variant="body2" color="textSecondary">
          {mode === 'attaching' ? t('chat.debug.pendingAttaching') : t('chat.debug.pendingArmed')}
        </Typography>
        <Typography variant="caption" color="textSecondary" sx={{ maxWidth: 420 }}>
          {mode === 'attaching' ? t('chat.debug.pendingAttachingHelp') : t('chat.debug.pendingArmedHelp')}
        </Typography>
      </Box>

      {/* The real control row, disabled: the buttons stay where they will be so
          the panel does not reflow when the debug state arrives. */}
      <Box
        sx={{
          display: 'flex',
          gap: 1,
          p: 1,
          borderTop: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Button variant="outlined" size="small" disabled>{t('chat.debug.previous')}</Button>
        <Button variant="contained" size="small" disabled>{t('chat.debug.stepNext')}</Button>
        <Button variant="contained" color="secondary" size="small" disabled>{t('chat.debug.continue')}</Button>
      </Box>
    </Paper>
  );
};

export default DebuggerPendingPanel;
