"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alpha, styled } from '@mui/material/styles';
import { Paper, Typography, Box, InputAdornment, TextField } from '@mui/material';
import { createLogger } from '@/utils/logger';
import { NodeType } from '@/frontend/types/flow/flow';
import SettingsIcon from '@mui/icons-material/Settings';
import OutputIcon from '@mui/icons-material/Output';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import DescriptionIcon from '@mui/icons-material/Description';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import BoltIcon from '@mui/icons-material/Bolt';
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded';
import MemoryRoundedIcon from '@mui/icons-material/MemoryRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import { RESOURCE_COLOR, SIGNAL_COLOR, TRIGGER_COLOR, TRIGGER_COLOR_LIGHT } from './CustomNodes';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getNodeTypes } from './nodeTypeCatalog';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/NodePalette.tsx');
// Constants for logging
const COMPONENT_NAME = 'NodePalette';

const PaletteContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1.4),
  width: '218px',
  height: '100%',
  minHeight: 0,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(1.2),
  overflowY: 'auto',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: 16,
  backgroundColor: theme.palette.mode === 'dark'
    ? 'rgba(17, 22, 41, 0.86)'
    : 'rgba(255, 255, 255, 0.9)',
  boxShadow: theme.palette.mode === 'dark'
    ? '0 16px 45px rgba(0,0,0,.22)'
    : '0 16px 45px rgba(49,45,99,.09)',
  backdropFilter: 'blur(18px)',
  [theme.breakpoints.down('md')]: {
    width: '100%',
    height: '68px',
    padding: theme.spacing(0.65),
    gap: theme.spacing(0.6),
    alignItems: 'flex-start',
    overflowX: 'auto',
    overflowY: 'hidden',
  },
}));

const NodeItem = styled(Paper, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: NodeType }>(({ theme, nodeType }) => ({
  padding: theme.spacing(1.25),
  width: '100%',
  minWidth: 0,
  borderRadius: '12px',
  backgroundColor: alpha(theme.palette.background.paper, 0.72),
  border: `1px solid ${theme.palette.divider}`,
  borderLeft: `3px solid ${
    nodeType === 'process'
      ? theme.palette.primary.main
      : nodeType === 'finish'
      ? theme.palette.success.main
      : nodeType === 'subflow'
      ? theme.palette.warning.main
      : nodeType === 'resource'
      ? RESOURCE_COLOR
      : nodeType === 'signal'
      ? SIGNAL_COLOR
      : nodeType === 'trigger'
      ? TRIGGER_COLOR
      : theme.palette.info.main
  }`,
  boxShadow: 'none',
  transition: 'transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
  cursor: 'grab',
  '&:hover': {
    transform: 'translateY(-2px)',
    borderColor: alpha(
      nodeType === 'process'
        ? theme.palette.primary.main
        : nodeType === 'finish'
        ? theme.palette.success.main
        : nodeType === 'subflow'
        ? theme.palette.warning.main
        : nodeType === 'resource'
        ? RESOURCE_COLOR
        : nodeType === 'signal'
        ? SIGNAL_COLOR
        : nodeType === 'trigger'
        ? TRIGGER_COLOR
        : theme.palette.info.main,
      0.55,
    ),
    boxShadow: `0 0 0 1px ${
      nodeType === 'process'
        ? theme.palette.primary.main
        : nodeType === 'finish'
        ? theme.palette.success.main
        : nodeType === 'subflow'
        ? theme.palette.warning.main
        : nodeType === 'resource'
        ? RESOURCE_COLOR
        : nodeType === 'signal'
        ? SIGNAL_COLOR
        : nodeType === 'trigger'
        ? TRIGGER_COLOR
        : theme.palette.info.main
    }, 0 14px 30px rgba(0,0,0,0.12)`
  },
  '&:active': {
    cursor: 'grabbing',
  },
  [theme.breakpoints.down('md')]: {
    width: 64,
    minWidth: 64,
    minHeight: 54,
    padding: theme.spacing(0.55),
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 2,
  },
}));

const NodeHeader = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: NodeType }>(({ theme, nodeType }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: `1px solid ${
    nodeType === 'process'
      ? theme.palette.primary.light
      : nodeType === 'finish'
      ? theme.palette.success.light
      : nodeType === 'subflow'
      ? theme.palette.warning.light
      : nodeType === 'resource'
      ? '#4DB6AC' // RESOURCE_COLOR light
      : nodeType === 'signal'
      ? '#B39DDB' // SIGNAL_COLOR light
      : nodeType === 'trigger'
      ? TRIGGER_COLOR_LIGHT
      : theme.palette.info.light
  }`,
  marginBottom: theme.spacing(1),
  paddingBottom: theme.spacing(0.5),
  [theme.breakpoints.down('md')]: {
    width: '100%',
    marginBottom: 0,
    paddingBottom: 0,
    borderBottom: 0,
    justifyContent: 'center',
  },
}));

const NodeContent = styled(Box)(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  [theme.breakpoints.down('md')]: {
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 2,
  },
}));

// Helper function to get the appropriate icon for each node type
const getNodeIcon = (type: NodeType) => {
  switch (type) {
    case 'process':
      return <MemoryRoundedIcon color="primary" />;
    case 'finish':
      return <OutputIcon color="success" />;
    case 'mcp':
      return <ExtensionRoundedIcon color="info" />;
    case 'subflow':
      return <AccountTreeIcon color="warning" />;
    case 'resource':
      return <DescriptionIcon sx={{ color: RESOURCE_COLOR }} />;
    case 'signal':
      return <NotificationsActiveIcon sx={{ color: SIGNAL_COLOR }} />;
    case 'trigger':
      return <BoltIcon sx={{ color: TRIGGER_COLOR }} />;
    default:
      return <SettingsIcon color="primary" />;
  }
};

export const NodePalette: React.FC<{
  authoringMode?: FlowAuthoringMode;
  onAddNode?: (nodeType: NodeType) => void;
}> = ({
  authoringMode = 'guided',
  onAddNode,
}) => {
  log.debug(`${COMPONENT_NAME}: Entering component`);
  const { t } = useI18n();
  const nodeTypes = useMemo(() => getNodeTypes(t), [t]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const focusQuickAdd = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener('openFlowQuickAdd', focusQuickAdd);
    return () => document.removeEventListener('openFlowQuickAdd', focusQuickAdd);
  }, []);

  // Add a node from touch, pointer, or keyboard without requiring drag support.
  const addNodeFromPalette = useCallback((nodeType: NodeType) => {
    log.debug(`${COMPONENT_NAME}.addNodeFromPalette: Adding ${nodeType} node`);
    onAddNode?.(nodeType);
    log.info(`${COMPONENT_NAME}.addNodeFromPalette: Requested ${nodeType} node`);
  }, [onAddNode]);

  const visibleNodeTypes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return nodeTypes
      .filter((node) => authoringMode === 'advanced' || node.type === 'process')
      .filter((node) => !normalizedQuery || `${node.label} ${node.description} ${node.shortLabel}`
        .toLowerCase()
        .includes(normalizedQuery));
  }, [authoringMode, nodeTypes, query]);
  
  const onDragStart = (event: React.DragEvent, nodeType: NodeType) => {
    log.debug(`${COMPONENT_NAME}.onDragStart: Entering method with nodeType=${nodeType}`);
    
    // Keep using the same data transfer type for compatibility with the drop handler
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
    
    // Add a drag image to make the drag operation more visible
    const dragPreview = document.createElement('div');
    const friendlyNode = nodeTypes.find(node => node.type === nodeType);
    dragPreview.textContent = friendlyNode?.label ?? t('flows.palette.step');
    Object.assign(dragPreview.style, {
      padding: '10px',
      background: 'white',
      border: '1px solid #ccc',
      borderRadius: '8px',
    });
    document.body.appendChild(dragPreview);
    
    log.debug(`${COMPONENT_NAME}.onDragStart: Created drag preview element`);
    
    // Set the drag image (with offset)
    try {
      event.dataTransfer.setDragImage(dragPreview, 75, 25);
      log.debug(`${COMPONENT_NAME}.onDragStart: Set drag image with offset (75, 25)`);
    } catch (err) {
      log.error(`${COMPONENT_NAME}.onDragStart: Error setting drag image:`, err);
    }
    
    // Clean up the temporary element after a short delay
    setTimeout(() => {
      document.body.removeChild(dragPreview);
      log.debug(`${COMPONENT_NAME}.onDragStart: Removed drag preview element`);
    }, 0);
    
    log.debug(`${COMPONENT_NAME}.onDragStart: Drag operation initialized`);
  };
  
  // Add handler for drag end events
  const onDragEnd = (event: React.DragEvent, nodeType: NodeType) => {
    log.debug(`${COMPONENT_NAME}.onDragEnd: Drag operation ended for nodeType=${nodeType}`);
  };

  log.debug(`${COMPONENT_NAME}: Rendering component`);
  return (
    <PaletteContainer elevation={2}>
      <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Typography className="node-palette-title" variant="subtitle1" fontWeight={800}>
          {t('flows.palette.title')}
        </Typography>
        <Typography variant="caption" color="text.secondary">A</Typography>
      </Box>
      <TextField
        inputRef={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        size="small"
        placeholder={t('flows.palette.search')}
        inputProps={{ 'aria-label': t('flows.palette.searchAria') }}
        sx={{ display: { xs: 'none', md: 'flex' } }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchRoundedIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />
      <Box
        display="flex"
        flexDirection={{ xs: 'row', md: 'column' }}
        gap={{ xs: 0.75, md: 1 }}
        width={{ xs: 'max-content', md: '100%' }}
      >
        {visibleNodeTypes.map((node) => (
          <NodeItem
            key={node.type}
            nodeType={node.type}
            elevation={1}
            draggable
            role="button"
            tabIndex={0}
            aria-label={`${node.label}: ${node.description}`}
            title={`${node.label} — ${node.description}`}
            onDragStart={(e) => onDragStart(e, node.type)}
            onDragEnd={(e) => onDragEnd(e, node.type)}
            onClick={() => addNodeFromPalette(node.type)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                addNodeFromPalette(node.type);
              }
            }}
          >
            <NodeHeader nodeType={node.type}>
              <NodeContent>
                {getNodeIcon(node.type)}
                <Typography
                  variant="caption"
                  fontWeight="bold"
                  sx={{
                    display: { xs: '-webkit-box', md: 'none' },
                    maxWidth: '100%',
                    overflow: 'hidden',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2,
                    overflowWrap: 'anywhere',
                    textAlign: 'center',
                    fontSize: '0.6rem',
                    lineHeight: 1,
                  }}
                >
                  {node.shortLabel}
                </Typography>
                <Typography variant="subtitle2" fontWeight="bold" sx={{ display: { xs: 'none', md: 'block' } }}>
                  {node.label}
                </Typography>
              </NodeContent>
            </NodeHeader>
            <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' } }}>
              {node.description}
            </Typography>
          </NodeItem>
        ))}
        {visibleNodeTypes.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, py: 1 }}>
            {t('flows.palette.noMatches')}
          </Typography>
        )}
      </Box>
    </PaletteContainer>
  );
};

export default NodePalette;
