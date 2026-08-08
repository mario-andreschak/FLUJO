'use client';

/**
 * The one place a registry install option is rendered and chosen (#392).
 *
 * Spotlight and Marketplace previously carried two near-identical copies of the
 * option list (TerminalIcon / CloudIcon rows, missing-input warnings, install
 * handoff). Any change to install semantics had to be made twice, correctly —
 * launch-and-connect support being exactly such a change. Both now render this
 * component; the behavioural differences that are real (Marketplace's trust
 * gate, Spotlight's curated env defaults) stay explicit options.
 */

import React from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography
} from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import CloudIcon from '@mui/icons-material/Cloud';
import PlayDisabledIcon from '@mui/icons-material/PlayDisabled';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { InstallOption, ManualLaunchOption } from '@/utils/mcp/registry';
import { missingRequiredInputs } from '@/utils/mcp/registry';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface InstallOptionListProps {
  options: InstallOption[];
  /** Curated env defaults (Spotlight) — a provided value is not "missing". */
  envDefaults?: Record<string, string>;
  /** Trust gate (Marketplace): rows stay visible but unclickable until confirmed. */
  disabled?: boolean;
  /** Install / hand off this option. Never called for a manual-launch row. */
  onSelect: (option: InstallOption) => void;
  /**
   * Save a launch-and-connect entry as an ordinary HTTP server the user starts
   * themselves. Absent ⇒ the action is not offered.
   */
  onConfigureAsRemote?: (option: ManualLaunchOption) => void;
}

/** Row for a package the user has to start by hand (#392, Phase 0/1). */
const ManualLaunchRow: React.FC<{
  option: ManualLaunchOption;
  disabled?: boolean;
  onConfigureAsRemote?: (option: ManualLaunchOption) => void;
}> = ({ option, disabled, onConfigureAsRemote }) => {
  const { t } = useI18n();

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(option.runLine);
    } catch {
      // Clipboard access can be denied; the command stays selectable as text.
    }
  };

  return (
    <Box sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <PlayDisabledIcon fontSize="small" color="disabled" />
        <Typography variant="body2" sx={{ wordBreak: 'break-all', flexGrow: 1 }}>
          {option.label}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
        {t('mcp.registry.manualLaunch.description')}
      </Typography>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          p: 1,
          borderRadius: 1,
          bgcolor: 'action.hover'
        }}
      >
        <Typography
          variant="caption"
          component="code"
          sx={{ flexGrow: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}
        >
          {option.runLine}
        </Typography>
        <Tooltip title={t('mcp.registry.manualLaunch.copyCommand')}>
          <IconButton
            size="small"
            onClick={copy}
            aria-label={t('mcp.registry.manualLaunch.copyCommand')}
          >
            <ContentCopyIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Box>
      {option.resolvedUrl ? (
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ mt: 1, wordBreak: 'break-all' }}
        >
          {option.resolvedUrl}
        </Typography>
      ) : null}
      {onConfigureAsRemote ? (
        <Button size="small" sx={{ mt: 1 }} disabled={disabled} onClick={() => onConfigureAsRemote(option)}>
          {t('mcp.registry.manualLaunch.configureAsRemote')}
        </Button>
      ) : null}
    </Box>
  );
};

export const InstallOptionList: React.FC<InstallOptionListProps> = ({
  options,
  envDefaults,
  disabled,
  onSelect,
  onConfigureAsRemote
}) => {
  const { t, formatList } = useI18n();
  const installable = options.filter(option => option.kind !== 'manual-launch');
  const manual = options.filter((option): option is ManualLaunchOption => option.kind === 'manual-launch');

  return (
    <>
      <List>
        {installable.map((option, index) => {
          const missing = missingRequiredInputs(option, envDefaults);
          return (
            <ListItemButton key={index} disabled={disabled} onClick={() => onSelect(option)}>
              <ListItemIcon>
                {option.kind === 'package' ? <TerminalIcon /> : <CloudIcon />}
              </ListItemIcon>
              <ListItemText
                primary={option.label}
                secondary={
                  missing.length > 0
                    ? t('mcp.marketplace.requires', { values: formatList(missing) })
                    : option.kind === 'package'
                      ? t('mcp.marketplace.runsLocal')
                      : t('mcp.marketplace.hostedRemote')
                }
                primaryTypographyProps={{ sx: { wordBreak: 'break-all' } }}
              />
            </ListItemButton>
          );
        })}
      </List>
      {manual.length > 0 ? (
        <Box>
          <Alert severity="info" sx={{ mb: 1 }}>
            {t('mcp.registry.manualLaunch.title')}
          </Alert>
          {manual.map((option, index) => (
            <ManualLaunchRow
              key={`manual-${index}`}
              option={option}
              disabled={disabled}
              onConfigureAsRemote={onConfigureAsRemote}
            />
          ))}
        </Box>
      ) : null}
    </>
  );
};

export interface InstallOptionPickerProps extends InstallOptionListProps {
  open: boolean;
  title: string;
  helpText?: string;
  onClose: () => void;
}

/** Dialog wrapper around {@link InstallOptionList} (used by Spotlight). */
const InstallOptionPicker: React.FC<InstallOptionPickerProps> = ({
  open,
  title,
  helpText,
  onClose,
  ...listProps
}) => {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {helpText ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {helpText}
          </Typography>
        ) : null}
        <InstallOptionList {...listProps} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('mcp.local.cancel')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default InstallOptionPicker;
