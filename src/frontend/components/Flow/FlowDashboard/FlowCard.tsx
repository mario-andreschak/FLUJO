"use client";

import React, { useState } from 'react';
import { 
  Card, 
  CardActionArea, 
  CardContent, 
  CardActions, 
  Button,
  Typography, 
  Box, 
  IconButton, 
  Tooltip, 
  Chip,
  Checkbox,
  alpha,
  Skeleton,
  styled,
  useTheme
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import ChatIcon from '@mui/icons-material/Chat';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Flow, NodeType } from '@/frontend/types/flow/flow';
import { getNodeColor } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { FlowValidationResult } from '@/utils/shared/flowValidation';
import { getFlowCardMetrics } from '@/utils/shared/flowCardMetrics';
import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { localizeFlowIssue } from '@/frontend/i18n/flowValidation';

const log = createLogger('components/Flow/FlowDashboard/FlowCard');

interface FlowCardProps {
  flow: Flow;
  selected: boolean;
  onSelect: (flowId: string) => void;
  /** Optional in picker mode; required for the management dashboard. */
  onDelete?: (flowId: string) => void;
  onCopy?: (flowId: string) => void;
  onEdit?: (flowId: string) => void;
  /** Start a new chat conversation bound to this flow (#148). Management mode only. */
  onOpenInChat?: (flowId: string) => void;
  /** Assign/clear this flow's organizing folder (#71). */
  onSetFolder?: (flowId: string, folder: string | undefined) => void;
  /** Toggle this flow's favorite flag (#120). Available in picker mode too. */
  onToggleFavorite?: (flowId: string) => void;
  /** Existing folders on the dashboard, for the "Move to folder" picker. */
  folders?: string[];
  /** Consistency-check result; drives the problem badge. */
  validation?: FlowValidationResult;
  /**
   * When true, the card is used purely to *select* a flow (#92): all
   * management actions (edit/copy/folder/delete) are hidden so the picker and
   * the dashboard share the exact same card body without drifting.
   */
  pickerMode?: boolean;
  /** Dashboard bulk-selection mode used by quick model replacement (#401). */
  selectionMode?: boolean;
}

// Styled card with hover effects
const StyledCard = styled(Card, {
  shouldForwardProp: (prop) => prop !== 'selected',
})<{ selected: boolean }>(({ theme, selected }) => ({
  display: 'grid',
  gridTemplateColumns: 'minmax(138px, 1.05fr) minmax(0, 0.95fr)',
  gridTemplateRows: 'auto minmax(0, 1fr) auto auto',
  gridTemplateAreas: `
    "title title"
    "preview details"
    "preview primary"
    "preview footer"
  `,
  height: '100%',
  minHeight: 286,
  position: 'relative',
  overflow: 'hidden',
  border: `1px solid ${selected ? theme.palette.primary.main : theme.palette.divider}`,
  boxShadow: selected
    ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.14)}, 0 24px 70px ${alpha(theme.palette.primary.main, 0.18)}`
    : `0 16px 45px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.18 : 0.07)}`,
  transition: 'transform 220ms cubic-bezier(0.2, 0.75, 0.2, 1), border-color 220ms ease, box-shadow 220ms ease',
  '&:hover': {
    borderColor: alpha(theme.palette.primary.main, 0.42),
    boxShadow: `0 26px 70px ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.12)}`,
    transform: 'translateY(-4px)',
  },
  '&::before': {
    content: '""',
    position: 'absolute',
    zIndex: 2,
    top: 0,
    left: 0,
    width: '100%',
    height: selected ? '3px' : '1px',
    opacity: selected ? 1 : 0.5,
    background: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main}, transparent)`,
  },
}));

// Preview area to show a simplified graph visualization
const PreviewArea = styled(Box)(({ theme }) => ({
  gridArea: 'preview',
  flex: 1,
  minWidth: 0,
  height: 236,
  backgroundColor: alpha(theme.palette.background.default, 0.82),
  backgroundImage: `
    linear-gradient(${alpha(theme.palette.divider, 0.55)} 1px, transparent 1px),
    linear-gradient(90deg, ${alpha(theme.palette.divider, 0.55)} 1px, transparent 1px),
    radial-gradient(circle at 25% 0%, ${alpha(theme.palette.primary.main, 0.12)}, transparent 52%)
  `,
  backgroundSize: '22px 22px, 22px 22px, auto',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: theme.spacing(1.25),
  marginRight: theme.spacing(0),
  overflow: 'hidden',
  position: 'relative',
}));

const FlowCard = ({
  flow,
  selected,
  onSelect,
  onDelete,
  onCopy,
  onEdit,
  onOpenInChat,
  onSetFolder,
  onToggleFavorite,
  folders = [],
  validation,
  pickerMode = false,
  selectionMode = false,
}: FlowCardProps) => {
  log.debug('Rendering FlowCard', { flowId: flow.id, flowName: flow.name });
  const theme = useTheme();
  const { t, tp, formatNumber } = useI18n();
  const [folderAnchorEl, setFolderAnchorEl] = useState<null | HTMLElement>(null);

  // Surface flow problems at a glance: red when it won't run (errors), amber for
  // advisory warnings. The tooltip lists the first few issues.
  const errorCount = validation?.errorCount ?? 0;
  const warningCount = validation?.warningCount ?? 0;
  const { stepCount, subagentCount, signalCount } = getFlowCardMetrics(flow);
  const badgeSeverity: 'error' | 'warning' | null =
    errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : null;
  const badgeTooltip = validation ? (
    <Box>
      <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        {errorCount > 0
          ? tp('flows.card.problem', errorCount)
          : tp('flows.card.warning', warningCount)}
      </Typography>
      {validation.issues.slice(0, 5).map((issue, i) => (
        <Typography key={i} variant="caption" sx={{ display: 'block' }}>
          • {localizeFlowIssue(issue, t)}
        </Typography>
      ))}
      {validation.issues.length > 5 && (
        <Typography variant="caption" sx={{ display: 'block', fontStyle: 'italic' }}>
          {t('flows.card.more', { count: formatNumber(validation.issues.length - 5) })}
        </Typography>
      )}
    </Box>
  ) : null;

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) onDelete(flow.id);
  };
  
  const handleCopyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCopy) onCopy(flow.id);
  };
  
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit) onEdit(flow.id);
    else onSelect(flow.id);
  };

  const handleOpenInChatClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onOpenInChat) onOpenInChat(flow.id);
  };

  const handleFolderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFolderAnchorEl(e.currentTarget as HTMLElement);
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    // The whole card is a CardActionArea that selects the flow — don't let the
    // star toggle bubble up into a selection (mirrors handleFolderClick).
    e.stopPropagation();
    if (onToggleFavorite) onToggleFavorite(flow.id);
  };
  
  // Render a faithful mini-map of the flow: real node positions/edges scaled to
  // fit, using the same per-type colors as the FlowBuilder canvas so the preview
  // matches what the user sees when editing.
  const renderFlowPreview = () => {
    if (flow.nodes.length === 0) {
      return (
        <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography color="textSecondary" align="center">
            {t('flows.card.nothing')}
          </Typography>
        </Box>
      );
    }

    // Approximate on-canvas node footprint (matches the builder's ~180px min width).
    const NODE_W = 180;
    const NODE_H = 70;
    const PAD = 40;

    const xs = flow.nodes.map(n => n.position?.x ?? 0);
    const ys = flow.nodes.map(n => n.position?.y ?? 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + NODE_W;
    const maxY = Math.max(...ys) + NODE_H;

    const viewBox = `${minX - PAD} ${minY - PAD} ${maxX - minX + PAD * 2} ${maxY - minY + PAD * 2}`;
    const center = (node: typeof flow.nodes[number]) => ({
      cx: (node.position?.x ?? 0) + NODE_W / 2,
      cy: (node.position?.y ?? 0) + NODE_H / 2,
    });

    return (
      <Box sx={{ width: '100%', height: '100%', p: 1 }}>
        <svg
          width="100%"
          height="100%"
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block' }}
        >
          {/* Edges first so nodes render on top */}
          {flow.edges.map((edge, index) => {
            const sourceNode = flow.nodes.find(n => n.id === edge.source);
            const targetNode = flow.nodes.find(n => n.id === edge.target);
            if (!sourceNode || !targetNode) return null;
            const s = center(sourceNode);
            const t = center(targetNode);
            return (
              <line
                key={edge.id || index}
                x1={s.cx}
                y1={s.cy}
                x2={t.cx}
                y2={t.cy}
                stroke={theme.palette.text.secondary}
                strokeWidth={2}
                opacity={0.5}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {flow.nodes.map((node) => {
            const x = node.position?.x ?? 0;
            const y = node.position?.y ?? 0;
            const type = (node.data?.type ?? 'process') as NodeType;
            const color = getNodeColor(type, theme);
            return (
              <g key={node.id}>
                <rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={12}
                  fill={color}
                  opacity={0.85}
                  stroke={theme.palette.background.paper}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={x + NODE_W / 2}
                  y={y + NODE_H / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize={NODE_H * 0.5}
                  fontWeight="bold"
                >
                  {type.substring(0, 1).toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>
      </Box>
    );
  };

  return (
    <StyledCard selected={selected} data-tutorial-flow-id={flow.id}>
      {selectionMode && (
        <Checkbox
          checked={selected}
          onChange={() => onSelect(flow.id)}
          onClick={(event) => event.stopPropagation()}
          inputProps={{ 'aria-label': t('flows.card.select', { name: flow.name }) }}
          sx={{
            position: 'absolute',
            top: 2,
            left: 2,
            zIndex: 3,
            bgcolor: alpha(theme.palette.background.paper, 0.78),
            borderRadius: 1.5,
          }}
        />
      )}
      {onToggleFavorite && !selectionMode && (
        <Tooltip title={flow.favorite ? t('flows.card.favoriteRemove') : t('flows.card.favoriteAdd')} arrow placement="top">
          <IconButton
            size="small"
            onClick={handleFavoriteClick}
            sx={{
              position: 'absolute',
              top: 4,
              left: 4,
              zIndex: 2,
              color: flow.favorite ? theme.palette.warning.main : theme.palette.text.secondary,
              backgroundColor: alpha(theme.palette.background.paper, 0.6),
              '&:hover': { backgroundColor: alpha(theme.palette.background.paper, 0.9) },
            }}
          >
            {flow.favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      {badgeSeverity && (
        <Tooltip title={badgeTooltip} arrow placement="top">
          <Box
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              px: 0.75,
              py: 0.25,
              borderRadius: 1,
              color: '#fff',
              backgroundColor:
                badgeSeverity === 'error' ? theme.palette.error.main : theme.palette.warning.main,
              boxShadow: theme.shadows[2],
              pointerEvents: 'auto',
            }}
          >
            {badgeSeverity === 'error' ? (
              <ErrorOutlineIcon sx={{ fontSize: 16 }} />
            ) : (
              <WarningAmberIcon sx={{ fontSize: 16 }} />
            )}
            <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1 }}>
              {badgeSeverity === 'error' ? errorCount : warningCount}
            </Typography>
          </Box>
        </Tooltip>
      )}
      <CardActionArea
        onClick={() => onSelect(flow.id)}
        sx={{
          gridArea: 'title',
          display: 'block',
          minWidth: 0,
          px: 1.5,
          py: 1.25,
          pl: onToggleFavorite || selectionMode ? 5.5 : 1.5,
          pr: badgeSeverity ? 7 : 1.5,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography variant="h6" component="div" noWrap title={flow.name}>
          {flow.name}
        </Typography>
      </CardActionArea>

      <CardActionArea
        onClick={() => onSelect(flow.id)}
        aria-label={t('flows.card.open', { name: flow.name })}
        sx={{
          gridArea: 'preview',
          minWidth: 0,
          height: 256,
          display: 'flex',
          alignItems: 'stretch',
        }}
      >
        <PreviewArea>
          {renderFlowPreview()}
        </PreviewArea>
      </CardActionArea>

      <CardActionArea
        onClick={() => onSelect(flow.id)}
        sx={{
          gridArea: 'details',
          gridRow: pickerMode || selectionMode ? '2 / 5' : undefined,
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
        }}
      >
        <CardContent sx={{ width: '100%', minWidth: 0, p: 1.5, '&:last-child': { pb: 1.25 } }}>
          {flow.description ? (
            <Tooltip title={flow.description} placement="bottom-start">
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {flow.description}
              </Typography>
            </Tooltip>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              {t('flows.card.noDescription')}
            </Typography>
          )}
          
          <Box sx={{ display: 'flex', gap: 0.5, mt: 1.25, flexWrap: 'wrap' }}>
            <Chip 
              size="small" 
              label={tp('flows.card.step', stepCount)}
              color="primary" 
              variant="outlined"
              sx={{ fontSize: '0.7rem', height: 20 }}
            />
            {subagentCount > 0 && (
              <Chip
                size="small"
                label={tp('flows.card.subagent', subagentCount)}
                color="secondary"
                variant="outlined"
                sx={{ fontSize: '0.7rem', height: 20 }}
              />
            )}
            <Chip
              size="small"
              label={tp('flows.card.signal', signalCount)}
              variant="outlined"
              sx={{ fontSize: '0.7rem', height: 20 }}
            />
          </Box>
        </CardContent>
      </CardActionArea>
      
      {!pickerMode && !selectionMode && (
        <>
          <CardActions sx={{ gridArea: 'primary', gap: 0.75, px: 1.25, pb: 1, pt: 0 }}>
            {onOpenInChat && (
              <Button
                size="small"
                variant="contained"
                startIcon={<ChatIcon fontSize="small" />}
                onClick={handleOpenInChatClick}
                sx={{ flex: 1, minWidth: 0 }}
              >
                {t('flows.card.use')}
              </Button>
            )}

            <Button
              data-tutorial-edit-flow-id={flow.id}
              size="small"
              variant="outlined"
              startIcon={<EditIcon fontSize="small" />}
              onClick={handleEditClick}
              sx={{ flex: 1, minWidth: 0 }}
            >
              {t('flows.card.edit')}
            </Button>
          </CardActions>

          <CardActions
            sx={{
              gridArea: 'footer',
              justifyContent: 'flex-end',
              gap: 0.25,
              px: 1,
              py: 0.625,
              minHeight: 42,
              borderTop: `1px solid ${theme.palette.divider}`,
              backgroundColor: alpha(theme.palette.background.default, 0.55),
            }}
          >
            {onCopy && (
              <Tooltip title={t('flows.card.copy')}>
                <IconButton size="small" onClick={handleCopyClick} aria-label={t('flows.card.copy')}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}

            {onSetFolder && (
              <Tooltip title={flow.folder ? t('flows.card.folder', { folder: flow.folder }) : t('flows.card.organize')}>
                <IconButton
                  size="small"
                  onClick={handleFolderClick}
                  color={flow.folder ? 'primary' : 'default'}
                  aria-label={t('flows.card.move')}
                >
                  <DriveFileMoveOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}

            {onDelete && (
              <Tooltip title={t('flows.card.delete')}>
                <IconButton size="small" onClick={handleDeleteClick} color="error" aria-label={t('flows.card.delete')}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </CardActions>
        </>
      )}

      {!pickerMode && onSetFolder && (
        <FolderAssignMenu
          anchorEl={folderAnchorEl}
          open={Boolean(folderAnchorEl)}
          currentFolder={flow.folder}
          folders={folders}
          onClose={() => setFolderAnchorEl(null)}
          onAssign={(folder) => onSetFolder(flow.id, folder)}
        />
      )}
    </StyledCard>
  );
};

// Loading skeleton version of the card
export const FlowCardSkeleton = () => (
  <Card
    sx={{
      height: '100%',
      minHeight: 286,
      display: 'grid',
      gridTemplateColumns: 'minmax(138px, 1.05fr) minmax(0, 0.95fr)',
      gridTemplateRows: 'auto 1fr auto auto',
    }}
  >
    <Box sx={{ gridColumn: '1 / -1', px: 1.5, py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
      <Skeleton variant="text" width="55%" height={30} />
    </Box>
    <Box sx={{ gridColumn: 1, gridRow: '2 / 5', p: 1.25, pr: 0 }}>
      <Skeleton variant="rounded" height="100%" sx={{ minHeight: 220 }} />
    </Box>
    <CardContent sx={{ gridColumn: 2, gridRow: 2, p: 1.5 }}>
      <Skeleton variant="text" />
      <Skeleton variant="text" width="85%" />
      <Box sx={{ display: 'flex', gap: 0.5, mt: 1 }}>
        <Skeleton variant="rectangular" width={60} height={20} />
        <Skeleton variant="rectangular" width={55} height={20} />
      </Box>
    </CardContent>
    <CardActions sx={{ gridColumn: 2, gridRow: 3, px: 1.25, pb: 1 }}>
      <Skeleton variant="rounded" width="48%" height={30} />
      <Skeleton variant="rounded" width="48%" height={30} />
    </CardActions>
    <CardActions sx={{ gridColumn: 2, gridRow: 4, justifyContent: 'flex-end', p: 0.75, borderTop: 1, borderColor: 'divider' }}>
      <Skeleton variant="circular" width={28} height={28} />
      <Skeleton variant="circular" width={28} height={28} />
      <Skeleton variant="circular" width={28} height={28} />
    </CardActions>
  </Card>
);

export default FlowCard;
