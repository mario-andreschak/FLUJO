import React, { memo, useState } from 'react';
import { 
  Handle, 
  Position, 
  NodeProps,
  Connection
} from '@xyflow/react';
import { styled, useTheme } from '@mui/material/styles';
import { 
  Paper, 
  Typography, 
  Box, 
  IconButton, 
  Collapse
} from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import SettingsIcon from '@mui/icons-material/Settings';
import OutputIcon from '@mui/icons-material/Output';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

const NodeContainer = styled(Paper, {
  shouldForwardProp: (prop) => !['nodeType', 'selected'].includes(prop as string),
})<{ 
  nodeType: 'start' | 'process' | 'finish' | 'mcp';
  selected?: boolean; 
}>(({ theme, nodeType, selected }) => ({
  padding: theme.spacing(1.5),
  minWidth: '180px',
  borderRadius: '8px',
  backgroundColor: theme.palette.background.paper,
  border: `2px solid ${
    nodeType === 'start'
      ? '#795548' // Brown color hex value
      : nodeType === 'process'
      ? theme.palette.secondary.main
      : nodeType === 'finish'
      ? theme.palette.success.main
      : theme.palette.info.main
  }`,
  boxShadow: selected 
    ? `0 0 0 2px ${theme.palette.primary.main}, 0 3px 10px rgba(0,0,0,0.2)` 
    : theme.shadows[2],
  transition: 'all 0.2s ease',
  '&:hover': {
    boxShadow: `0 0 0 1px ${
      nodeType === 'start'
        ? '#795548' // Brown color hex value
        : nodeType === 'process'
        ? theme.palette.secondary.main
        : nodeType === 'finish'
        ? theme.palette.success.main
        : theme.palette.info.main
    }, 0 3px 10px rgba(0,0,0,0.1)`
  }
}));

const NodeHeader = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: 'start' | 'process' | 'finish' | 'mcp' }>(({ theme, nodeType }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: `1px solid ${
    nodeType === 'start'
      ? '#A1887F' // Lighter brown color for header border
      : nodeType === 'process'
      ? theme.palette.secondary.light
      : nodeType === 'finish'
      ? theme.palette.success.light
      : theme.palette.info.light
  }`,
  marginBottom: theme.spacing(1),
  paddingBottom: theme.spacing(0.5),
}));

const NodeContent = styled(Box)({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

const NodeDetails = styled(Box)(({ theme }) => ({
  marginTop: theme.spacing(1),
  fontSize: '0.8rem',
}));

const PropertyRow = styled(Box)(({ theme }) => ({
  display: 'flex',
  justifyContent: 'space-between',
  padding: theme.spacing(0.5, 0),
  borderBottom: `1px dashed ${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
}));

interface CustomNodeProps extends NodeProps {
  nodeType: 'start' | 'process' | 'finish' | 'mcp';
}

const getNodeIcon = (type: 'start' | 'process' | 'finish' | 'mcp') => {
  switch (type) {
    case 'start':
      return <ChatIcon sx={{ color: '#795548' }} />; // Brown color for icon
    case 'process':
      return <SettingsIcon color="secondary" />;
    case 'finish':
      return <OutputIcon color="success" />;
    case 'mcp':
      return <SettingsIcon color="info" />;
    default:
      return <ChatIcon sx={{ color: '#795548' }} />; // Brown color for icon
  }
};

const getNodeColor = (type: 'start' | 'process' | 'finish' | 'mcp', theme: any) => {
  switch (type) {
    case 'start':
      return '#795548'; // Brown color hex value
    case 'process':
      return theme.palette.secondary.main;
    case 'finish':
      return theme.palette.success.main;
    case 'mcp':
      return theme.palette.info.main;
    default:
      return '#795548'; // Brown color hex value
  }
};

// Custom handle styles for different connection types
const getMCPHandleStyle = (theme: any) => ({
  backgroundColor: theme.palette.info.main,
  borderColor: theme.palette.mode === 'dark' ? theme.palette.background.paper : 'white',
  width: 16,
  height: 16,
  borderRadius: 8,
  borderWidth: 2
});

const getProcessHandleStyle = (theme: any) => ({
  backgroundColor: theme.palette.secondary.main,
  borderColor: theme.palette.mode === 'dark' ? theme.palette.background.paper : 'white',
  width: 16,
  height: 16,
  borderRadius: 8,
  borderWidth: 2
});

const getMCPConnectionHandleStyle = (theme: any) => ({
  backgroundColor: theme.palette.primary.main,
  borderColor: theme.palette.mode === 'dark' ? theme.palette.background.paper : 'white',
  width: 16,
  height: 16,
  borderRadius: 8,
  borderWidth: 2
});

const CustomNode = ({ data, nodeType, selected }: CustomNodeProps & { selected?: boolean }) => {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const nodeData = data || { label: 'No Label', properties: {} };
  const label = typeof nodeData.label === 'string' ? nodeData.label : 'No Label';
  const properties = nodeData.properties || {};
  const propCount = Object.keys(properties).length;
  
  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };
  
  // Render different handle configurations based on node type
  const renderHandles = () => {
    if (nodeType === 'mcp') {
      // MCP nodes have connectors on all 4 sides
      return (
        <>
          <Handle 
            id="mcp-top"
            type="target" 
            position={Position.Top} 
            style={getMCPHandleStyle(theme)} 
          />
          <Handle 
            id="mcp-right"
            type="target" 
            position={Position.Right} 
            style={getMCPHandleStyle(theme)} 
          />
          <Handle 
            id="mcp-bottom"
            type="source" 
            position={Position.Bottom} 
            style={getMCPHandleStyle(theme)} 
          />
          <Handle 
            id="mcp-left"
            type="target" 
            position={Position.Left} 
            style={getMCPHandleStyle(theme)} 
          />
        </>
      );
    } else if (nodeType === 'process') {
      // Process nodes have two types of connectors:
      // - Top/bottom: Connect to Entry, Finish, and other Process nodes
      // - Left/right: Connect ONLY to MCP nodes
      return (
        <>
          {/* Standard process flow connectors (top/bottom) */}
          <Handle 
            id="process-top"
            type="target" 
            position={Position.Top} 
            style={getProcessHandleStyle(theme)} 
          />
          <Handle 
            id="process-bottom"
            type="source" 
            position={Position.Bottom} 
            style={getProcessHandleStyle(theme)} 
          />
          
          {/* MCP connection connectors (left/right) */}
          <Handle 
            id="process-left-mcp"
            type="source" 
            position={Position.Left} 
            style={getMCPConnectionHandleStyle(theme)} 
          />
          <Handle 
            id="process-right-mcp"
            type="source" 
            position={Position.Right} 
            style={getMCPConnectionHandleStyle(theme)} 
          />
        </>
      );
    } else if (nodeType === 'start') {
      // Start nodes only have a bottom connector
      return (
        <Handle 
          id="start-bottom"
          type="source" 
          position={Position.Bottom} 
          style={getProcessHandleStyle(theme)} 
        />
      );
    } else if (nodeType === 'finish') {
      // Finish nodes only have a top connector
      return (
        <Handle 
          id="finish-top"
          type="target" 
          position={Position.Top} 
          style={getProcessHandleStyle(theme)} 
        />
      );
    }
    
    return null;
  };
  
  return (
    <>
      <NodeContainer elevation={2} nodeType={nodeType} selected={selected}>
        {renderHandles()}
        
        <NodeHeader nodeType={nodeType}>
          <NodeContent>
            {getNodeIcon(nodeType)}
            <Typography variant="subtitle2" fontWeight="bold">
              {label}
            </Typography>
          </NodeContent>
          
          {propCount > 0 && (
            <IconButton 
              size="small" 
              onClick={handleExpand}
              sx={{ padding: 0.5 }}
            >
              {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          )}
        </NodeHeader>
        
        {/* Display description if available
        {data.description as string && (
          <Typography 
            variant="caption" 
            color="text.secondary" 
            sx={{ 
              display: 'block', 
              mt: 0.5, 
              mb: 1,
              fontStyle: 'italic',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
          </Typography>
        )} */}
        
        <Collapse in={expanded}>
          <NodeDetails>
            {Object.entries(properties).map(([key, value]) => (
              <PropertyRow key={key}>
                <Typography variant="caption" sx={{ fontWeight: 'bold' }}>
                  {key}:
                </Typography>
                <Typography variant="caption">
                  {String(value).substring(0, 30)}{String(value).length > 30 ? '...' : ''}
                </Typography>
              </PropertyRow>
            ))}
          </NodeDetails>
        </Collapse>
        
        {propCount > 0 && !expanded && (
          <Typography variant="caption" color="text.secondary">
            {`${propCount} properties configured`}
          </Typography>
        )}
      </NodeContainer>
    </>
  );
};

export const StartNode = memo(function StartNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="start" selected={props.selected} />;
});

export const ProcessNode = memo(function ProcessNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="process" selected={props.selected} />;
});

export const FinishNode = memo(function FinishNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="finish" selected={props.selected} />;
});

export const MCPNode = memo(function MCPNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="mcp" selected={props.selected} />;
});
