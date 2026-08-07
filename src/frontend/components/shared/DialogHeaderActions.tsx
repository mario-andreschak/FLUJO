"use client";

import React from 'react';
import type { ReactNode } from 'react';
import { Box, DialogTitle, IconButton, Typography } from '@mui/material';
import type { TypographyProps } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AskFlujoButton from '@/frontend/components/AskFlujo/AskFlujoButton';
import BugReportButton from '@/frontend/components/BugReport/BugReportButton';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface DialogHeaderActionsProps {
  /** Title content. Plain strings are wrapped in a `Typography variant="h6"`; pass a node for custom markup. */
  title: string | ReactNode;
  onClose: () => void;
  /** Show the `AskFlujoButton`. Defaults to `true`. */
  showAskFlujo?: boolean;
  /** Show the `BugReportButton` (icon variant). Defaults to `true`. */
  showBugReport?: boolean;
  /** Extra buttons (e.g. refresh, docs link) rendered before the Ask FLUJO / Report a bug cluster. */
  additionalActions?: ReactNode;
  /** Props forwarded to the `Typography` used to render a string `title`. Ignored when `title` is a node. */
  titleProps?: TypographyProps;
}

/**
 * Standardized modal header: title on the left, a right-aligned action
 * cluster (`additionalActions` → Ask FLUJO → Report a bug → Close) on the
 * right. Matches the spacing/padding already used by
 * `ProcessNodePropertiesModal` so it can be dropped into any `Dialog` without
 * a visual regression.
 */
export default function DialogHeaderActions({
  title,
  onClose,
  showAskFlujo = true,
  showBugReport = true,
  additionalActions,
  titleProps,
}: DialogHeaderActionsProps) {
  const { t } = useI18n();

  return (
    <DialogTitle component="div" sx={{ px: { xs: 2, sm: 3 }, py: { xs: 1.5, sm: 2 } }}>
      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
        {typeof title === 'string' ? (
          <Typography variant="h6" sx={{ minWidth: 0, overflowWrap: 'anywhere' }} {...titleProps}>
            {title}
          </Typography>
        ) : (
          title
        )}
        <Box display="flex" alignItems="center" gap={0.5} flexShrink={0}>
          {additionalActions}
          {showAskFlujo && <AskFlujoButton />}
          {showBugReport && <BugReportButton variant="icon" />}
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label={t('common.close')}>
            <CloseIcon />
          </IconButton>
        </Box>
      </Box>
    </DialogTitle>
  );
}
