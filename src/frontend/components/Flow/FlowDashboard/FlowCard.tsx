"use client";

import React from 'react';
import { 
  Card, 
  CardActionArea, 
  CardContent, 
  CardActions, 
  Typography, 
  Box, 
  IconButton, 
  Tooltip, 
  Chip,
  alpha,
  Skeleton,
  styled,
  useTheme
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import { Flow } from '@/frontend/types/flow/flow';
import { getNodeColor } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { createLogger } from '@/utils/logger';

const log = createLogger('components/Flow/FlowDashboard/FlowCard');

interface FlowCardProps {
  flow: Flow;
  selected: boolean;
  onSelect: (flowId: string) => void;
  onDelete: (flowId: string) => void;
  onCopy?: (flowId: string) => void;
  onEdit?: (flowId: string) => void;
}

// Styled card with hover effects
const StyledCard = styled(Card, {
  shouldForwardProp: (prop) => prop !== 'selected',
})<{ selected: boolean }>(({ theme, selected }) => ({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  position: 'relative',
  border: selected ? `2px solid ${theme.palette.primary.main}` : 'none',
  boxShadow: selected ? theme.shadows[4] : theme.shadows[1],
  '&:hover': {
    boxShadow: theme.shadows[6],
    transform: 'translateY(-4px)',
  },
  '&::before': selected ? {
    content: '""',
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '4px',
    backgroundColor: theme.palette.primary.main,
  } : {},
}));

// Preview area to show a simplified graph visualization
const PreviewArea = styled(Box)(({ theme }) => ({
  height: '140px',
  backgroundColor: alpha(theme.palette.background.default, 0.7),
  borderRadius: theme.shape.borderRadius,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: theme.spacing(1),
  overflow: 'hidden',
  position: 'relative',
}));

const FlowCard = ({ 
  flow, 
  selected, 
  onSelect, 
  onDelete, 
  onCopy, 
  onEdit
}: FlowCardProps) => {
  log.debug('Rendering FlowCard', { flowId: flow.id, flowName: flow.name });
  const theme = useTheme();

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(flow.id);
  };
  
  const handleCopyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCopy) onCopy(flow.id);
  };
  
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit) onEdit(flow.id);
  };
  
  // Render a faithful mini-map of the flow: real node positions/edges scaled to
  // fit, using the same per-type colors as the FlowBuilder canvas so the preview
  // matches what the user sees when editing.
  const renderFlowPreview = () => {
    if (flow.nodes.length === 0) {
      return (
        <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography color="textSecondary" align="center">
            Empty Flow
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
            const type = (node.data?.type ?? 'process') as 'start' | 'process' | 'finish' | 'mcp';
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
    <StyledCard selected={selected}>
      <CardActionArea 
        onClick={() => onSelect(flow.id)}
        sx={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'stretch',
          height: '100%',
          position: 'relative',
        }}
      >
        <PreviewArea>
          {renderFlowPreview()}
        </PreviewArea>
        
        <CardContent sx={{ flexGrow: 1, pb: 0 }}>
          <Typography variant="h6" component="div" noWrap>
            {flow.name}
          </Typography>
          
          <Box sx={{ display: 'flex', gap: 0.5, mt: 1, flexWrap: 'wrap' }}>
            <Chip 
              size="small" 
              label={`${flow.nodes.length} nodes`} 
              color="primary" 
              variant="outlined"
              sx={{ fontSize: '0.7rem', height: 20 }}
            />
            <Chip 
              size="small" 
              label={`${flow.edges.length} connections`} 
              color="secondary" 
              variant="outlined"
              sx={{ fontSize: '0.7rem', height: 20 }}
            />
          </Box>
        </CardContent>
      </CardActionArea>
      
      <CardActions sx={{ 
        justifyContent: 'flex-end', 
        p: 1,
        opacity: 0.7,
        '&:hover': {
          opacity: 1
        }
      }}>
        {onEdit && (
          <Tooltip title="Edit flow metadata">
            <IconButton size="small" onClick={handleEditClick}>
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        
        {onCopy && (
          <Tooltip title="Copy flow">
            <IconButton size="small" onClick={handleCopyClick}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        
        <Tooltip title="Delete flow">
          <IconButton size="small" onClick={handleDeleteClick} color="error">
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </CardActions>
    </StyledCard>
  );
};

// Loading skeleton version of the card
export const FlowCardSkeleton = () => (
  <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <Box sx={{ p: 1 }}>
      <Skeleton variant="rectangular" height={140} />
    </Box>
    <CardContent sx={{ flexGrow: 1 }}>
      <Skeleton variant="text" width="80%" height={30} />
      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        <Skeleton variant="rectangular" width={60} height={20} />
        <Skeleton variant="rectangular" width={90} height={20} />
      </Box>
    </CardContent>
    <CardActions sx={{ justifyContent: 'flex-end', p: 1 }}>
      <Skeleton variant="circular" width={28} height={28} />
      <Skeleton variant="circular" width={28} height={28} />
      <Skeleton variant="circular" width={28} height={28} />
    </CardActions>
  </Card>
);

export default FlowCard;
