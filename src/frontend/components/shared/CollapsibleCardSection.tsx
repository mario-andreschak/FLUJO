"use client";

import React from 'react';
import { Box, Collapse, IconButton, Typography, Chip, useTheme } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';

export interface CollapsibleCardSectionProps {
  /** Header text (folder name, sort bucket label, …). */
  label: string;
  /** Item count shown as a chip in the header. */
  count: number;
  /** Whether the section body is expanded. Controlled by the parent. */
  expanded: boolean;
  /** Toggle handler. */
  onToggle: () => void;
  /** Show a small folder glyph before the label (used for #71 folder view). */
  showFolderIcon?: boolean;
  children: React.ReactNode;
}

/**
 * A reusable collapsible section shell used to group cards on the Models / MCP /
 * Flow surfaces — shared by explicit folders (#71) and sort-derived buckets
 * (#73) so the two features render identically. Purely presentational; the
 * parent owns the expand/collapse state (keyed by group).
 */
const CollapsibleCardSection = ({
  label,
  count,
  expanded,
  onToggle,
  showFolderIcon = false,
  children,
}: CollapsibleCardSectionProps) => {
  const theme = useTheme();

  return (
    <Box sx={{ mb: 1.5 }}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.75,
          borderRadius: 1,
          cursor: 'pointer',
          userSelect: 'none',
          backgroundColor: theme.palette.background.default,
          border: `1px solid ${theme.palette.divider}`,
          '&:hover': { backgroundColor: theme.palette.action.hover },
        }}
      >
        <IconButton
          size="small"
          aria-label={expanded ? 'Collapse section' : 'Expand section'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          sx={{
            transition: 'transform 0.2s',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        >
          <ExpandMoreIcon fontSize="small" />
        </IconButton>
        {showFolderIcon && (
          <FolderOutlinedIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        )}
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Chip label={count} size="small" sx={{ height: 20, fontSize: '0.7rem' }} />
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ pt: 1.5 }}>{children}</Box>
      </Collapse>
    </Box>
  );
};

export default CollapsibleCardSection;
