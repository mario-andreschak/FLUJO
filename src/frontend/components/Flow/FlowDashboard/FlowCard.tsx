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
  styled
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import { Flow } from '@/frontend/types/flow/flow';
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
  
  // Generate simple flow preview
  // In a real implementation, this could render a simplified version of the flow graph
  const renderFlowPreview = () => {
    // Simple representation of nodes as circles
    return (
      <Box sx={{ 
        width: '100%', 
        height: '100%', 
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 1,
        position: 'relative'
      }}>
        {flow.nodes.length > 0 ? (
          <svg width="100%" height="100%" style={{ maxHeight: 120 }}>
            <g transform="translate(10,10)">
              {flow.nodes.map((node, index) => {
                // Calculate position for simple visualization
                const x = (index % 3) * 70 + 30;
                const y = Math.floor(index / 3) * 50 + 30;
                
                return (
                  <g key={node.id}>
                    <circle
                      cx={x}
                      cy={y}
                      r={20}
                      fill={
                        node.data.type === 'start' ? '#4caf50' :
                        node.data.type === 'finish' ? '#f44336' :
                        node.data.type === 'mcp' ? '#ff9800' : '#2196f3'
                      }
                      opacity={0.7}
                    />
                    <text
                      x={x}
                      y={y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="white"
                      fontSize="10px"
                    >
                      {node.data.type.substring(0, 1).toUpperCase()}
                    </text>
                  </g>
                );
              })}
              
              {/* Simplified edge representation */}
              {flow.edges.map((edge, index) => {
                // Find source and target nodes
                const sourceNode = flow.nodes.find(n => n.id === edge.source);
                const targetNode = flow.nodes.find(n => n.id === edge.target);
                
                if (!sourceNode || !targetNode) return null;
                
                // Calculate simplified positions
                const sourceIndex = flow.nodes.indexOf(sourceNode);
                const targetIndex = flow.nodes.indexOf(targetNode);
                
                const sourceX = (sourceIndex % 3) * 70 + 30;
                const sourceY = Math.floor(sourceIndex / 3) * 50 + 30;
                
                const targetX = (targetIndex % 3) * 70 + 30;
                const targetY = Math.floor(targetIndex / 3) * 50 + 30;
                
                return (
                  <line
                    key={index}
                    x1={sourceX}
                    y1={sourceY}
                    x2={targetX}
                    y2={targetY}
                    stroke="#888"
                    strokeWidth="2"
                    opacity={0.5}
                  />
                );
              })}
            </g>
          </svg>
        ) : (
          <Typography color="textSecondary" align="center">
            Empty Flow
          </Typography>
        )}
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
