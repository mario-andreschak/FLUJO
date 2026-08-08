"use client";

import React from 'react';
import { Box, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useWorkspaces } from '@/frontend/hooks/useWorkspaces';
import { workspaceColor } from '@/frontend/utils/workspaceSelection';

/**
 * Colored workspace tabs (#406).
 *
 * Only rendered when more than one workspace exists on disk. A single-workspace
 * install — which is every install until someone creates a second workspace
 * directory — sees exactly the navbar it saw before, so this feature costs
 * nothing to anyone who does not use it. (Workspace creation is out of scope for
 * #406; the tabs list what the filesystem actually contains.)
 *
 * Colors come from the workspace NAME, not from stored metadata, so a workspace
 * looks the same on every machine and no colour state can drift out of sync with
 * the directory listing.
 */

interface WorkspaceTabsProps {
  /** 'bar' = desktop AppBar tab strip, 'drawer' = compact/mobile list. */
  variant?: 'bar' | 'drawer';
  /** Called after a switch, so the drawer can close itself. */
  onSwitch?: () => void;
}

export function WorkspaceTabs({ variant = 'bar', onSwitch }: WorkspaceTabsProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const { workspaces, selected, select } = useWorkspaces();

  if (workspaces.length <= 1) return null;

  const handleSelect = (workspace: string) => {
    select(workspace);
    onSwitch?.();
  };

  if (variant === 'drawer') {
    return (
      <Box sx={{ px: 1.4, pb: 1.2 }}>
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', display: 'block', mb: 0.6 }}
        >
          {t('nav.workspaces')}
        </Typography>
        <Stack direction="row" spacing={0.8} sx={{ flexWrap: 'wrap', gap: 0.8 }}>
          {workspaces.map(workspace => {
            const color = workspace.color || workspaceColor(workspace.name);
            const isActive = workspace.name === selected;
            return (
              <Chip
                key={workspace.name}
                label={workspace.name}
                size="small"
                clickable
                aria-current={isActive ? 'true' : undefined}
                onClick={() => handleSelect(workspace.name)}
                sx={{
                  borderRadius: 2,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? theme.palette.common.white : 'text.primary',
                  bgcolor: isActive ? color : alpha(color, 0.14),
                  border: `1px solid ${alpha(color, isActive ? 0.9 : 0.35)}`,
                  '&:hover': { bgcolor: isActive ? color : alpha(color, 0.24) },
                }}
              />
            );
          })}
        </Stack>
      </Box>
    );
  }

  const activeIndex = Math.max(
    0,
    workspaces.findIndex(workspace => workspace.name === selected),
  );

  return (
    <Tabs
      value={activeIndex}
      variant="scrollable"
      scrollButtons="auto"
      aria-label={t('nav.workspaces')}
      data-app-workspace-tabs
      onChange={(_event, index: number) => {
        const next = workspaces[index];
        if (next) handleSelect(next.name);
      }}
      sx={{
        minHeight: 34,
        '& .MuiTabs-indicator': {
          height: 3,
          borderRadius: 2,
          // The indicator takes the ACTIVE workspace's colour, so the current
          // namespace is identifiable at a glance and not just by label.
          backgroundColor:
            workspaces[activeIndex]?.color || workspaceColor(selected),
        },
      }}
    >
      {workspaces.map(workspace => {
        const color = workspace.color || workspaceColor(workspace.name);
        return (
          <Tab
            key={workspace.name}
            disableRipple
            label={
              <Stack direction="row" alignItems="center" spacing={0.7}>
                <Box
                  aria-hidden="true"
                  sx={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    bgcolor: color,
                    boxShadow: `0 0 8px ${alpha(color, 0.8)}`,
                  }}
                />
                <span>{workspace.name}</span>
              </Stack>
            }
            sx={{
              minHeight: 34,
              px: 1.2,
              textTransform: 'none',
              fontSize: '0.78rem',
              '&.Mui-selected': { color: 'text.primary', fontWeight: 700 },
            }}
          />
        );
      })}
    </Tabs>
  );
}

export default WorkspaceTabs;
