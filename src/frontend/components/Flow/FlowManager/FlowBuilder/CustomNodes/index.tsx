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
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import DescriptionIcon from '@mui/icons-material/Description';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { NodeType } from '@/frontend/types/flow/flow';

// Resource nodes (Tier 3) use a teal literal — the MUI palette slots are all
// taken (secondary=process, success=finish, info=mcp, warning=subflow) and the
// start node set the hex-literal precedent.
export const RESOURCE_COLOR = '#009688';
const RESOURCE_COLOR_LIGHT = '#4DB6AC';

// Signal nodes (issue #117) use a deep-purple literal — same reason as the
// resource teal: the MUI palette slots are all taken.
export const SIGNAL_COLOR = '#7E57C2';
const SIGNAL_COLOR_LIGHT = '#B39DDB';

// One authority for per-type node colors instead of five repeated ternary
// chains. `main` styles borders/icons; `light` styles the header divider.
const NODE_TYPE_COLORS: Record<NodeType, { main: (theme: any) => string; light: (theme: any) => string }> = {
  start: { main: () => '#795548', light: () => '#A1887F' }, // Brown
  process: { main: (t) => t.palette.secondary.main, light: (t) => t.palette.secondary.light },
  finish: { main: (t) => t.palette.success.main, light: (t) => t.palette.success.light },
  mcp: { main: (t) => t.palette.info.main, light: (t) => t.palette.info.light },
  subflow: { main: (t) => t.palette.warning.main, light: (t) => t.palette.warning.light },
  resource: { main: () => RESOURCE_COLOR, light: () => RESOURCE_COLOR_LIGHT },
  signal: { main: () => SIGNAL_COLOR, light: () => SIGNAL_COLOR_LIGHT },
};

const nodeMainColor = (type: NodeType, theme: any) => (NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.start).main(theme);
const nodeLightColor = (type: NodeType, theme: any) => (NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.start).light(theme);

const NodeContainer = styled(Paper, {
  shouldForwardProp: (prop) => !['nodeType', 'selected'].includes(prop as string),
})<{
  nodeType: NodeType;
  selected?: boolean;
}>(({ theme, nodeType, selected }) => ({
  padding: theme.spacing(1.5),
  // Fixed (not min) width so every node is the same size: with equal widths and
  // grid snapping, node centers line up vertically, so top/bottom handles align
  // and edges run straight instead of jogging "around the corner".
  width: '200px',
  borderRadius: '8px',
  backgroundColor: theme.palette.background.paper,
  border: `2px solid ${nodeMainColor(nodeType, theme)}`,
  boxShadow: selected
    ? `0 0 0 2px ${theme.palette.primary.main}, 0 3px 10px rgba(0,0,0,0.2)`
    : theme.shadows[2],
  transition: 'all 0.2s ease',
  '&:hover': {
    boxShadow: `0 0 0 1px ${nodeMainColor(nodeType, theme)}, 0 3px 10px rgba(0,0,0,0.1)`
  }
}));

const NodeHeader = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: NodeType }>(({ theme, nodeType }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: `1px solid ${nodeLightColor(nodeType, theme)}`,
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
  nodeType: NodeType;
}

const getNodeIcon = (type: NodeType) => {
  switch (type) {
    case 'start':
      return <ChatIcon sx={{ color: '#795548' }} />; // Brown color for icon
    case 'process':
      return <SettingsIcon color="secondary" />;
    case 'finish':
      return <OutputIcon color="success" />;
    case 'mcp':
      return <SettingsIcon color="info" />;
    case 'subflow':
      return <AccountTreeIcon sx={{ color: 'warning.main' }} />;
    case 'resource':
      // Same icon vocabulary as the resource browser (ServerResources.tsx).
      return <DescriptionIcon sx={{ color: RESOURCE_COLOR }} />;
    case 'signal':
      return <NotificationsActiveIcon sx={{ color: SIGNAL_COLOR }} />;
    default:
      return <ChatIcon sx={{ color: '#795548' }} />; // Brown color for icon
  }
};

export const getNodeColor = (type: NodeType, theme: any) => nodeMainColor(type, theme);

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

const getResourceHandleStyle = (theme: any) => ({
  backgroundColor: RESOURCE_COLOR,
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
  const properties = (nodeData.properties || {}) as Record<string, unknown>;
  // Signal nodes (issue #164) are just a *named* signal: the display name IS the
  // signal name (topic). Stay defensive so freshly-dropped / legacy nodes still
  // render a sensible caption when the topic hasn't been set yet.
  const label =
    nodeType === 'signal'
      ? (typeof properties.topic === 'string' && properties.topic.trim()
          ? properties.topic.trim()
          : (typeof nodeData.label === 'string' && nodeData.label ? nodeData.label : 'Signal'))
      : (typeof nodeData.label === 'string' ? nodeData.label : 'No Label');
  // For signal nodes the topic is already shown as the header/display name, so
  // hide it from the expandable property rows to avoid showing it twice.
  const displayProperties =
    nodeType === 'signal'
      ? Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'topic'))
      : properties;
  const propCount = Object.keys(displayProperties).length;
  
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
      // Process nodes have three types of connectors:
      // - Top/bottom: Connect to Entry, Finish, and other Process nodes
      // - Left/right at 30%: Connect ONLY to MCP nodes
      // - Left/right at 70%: Connect ONLY to Resource nodes (Tier 3)
      // (Edges reference handle IDS, so nudging the mcp handles to 30% is
      // purely cosmetic and never breaks existing flows.)
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

          {/* MCP connection connectors (left/right, upper) */}
          <Handle
            id="process-left-mcp"
            type="source"
            position={Position.Left}
            style={{ ...getMCPConnectionHandleStyle(theme), top: '30%' }}
          />
          <Handle
            id="process-right-mcp"
            type="source"
            position={Position.Right}
            style={{ ...getMCPConnectionHandleStyle(theme), top: '30%' }}
          />

          {/* Resource connection connectors (left/right, lower). Left is the
              consume INPUT (resource-out → here); right is the produce OUTPUT
              (here → resource-in). */}
          <Handle
            id="process-left-resource"
            type="target"
            position={Position.Left}
            style={{ ...getResourceHandleStyle(theme), top: '70%' }}
          />
          <Handle
            id="process-right-resource"
            type="source"
            position={Position.Right}
            style={{ ...getResourceHandleStyle(theme), top: '70%' }}
          />
        </>
      );
    } else if (nodeType === 'resource') {
      // Resource nodes (Tier 3): data flows out of the right handle into a
      // consuming step, and into the left handle from a producing step.
      return (
        <>
          <Handle
            id="resource-in"
            type="target"
            position={Position.Left}
            style={getResourceHandleStyle(theme)}
          />
          <Handle
            id="resource-out"
            type="source"
            position={Position.Right}
            style={getResourceHandleStyle(theme)}
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
    } else if (nodeType === 'subflow') {
      // Subflow nodes sit inline in the vertical flow: in from above, out below.
      return (
        <>
          <Handle
            id="subflow-top"
            type="target"
            position={Position.Top}
            style={getProcessHandleStyle(theme)}
          />
          <Handle
            id="subflow-bottom"
            type="source"
            position={Position.Bottom}
            style={getProcessHandleStyle(theme)}
          />
        </>
      );
    } else if (nodeType === 'signal') {
      // Signal nodes (issue #117) sit inline like a subflow: in from above,
      // out below. They emit an event when traversed and pass through.
      return (
        <>
          <Handle
            id="signal-top"
            type="target"
            position={Position.Top}
            style={getProcessHandleStyle(theme)}
          />
          <Handle
            id="signal-bottom"
            type="source"
            position={Position.Bottom}
            style={getProcessHandleStyle(theme)}
          />
        </>
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
            {Object.entries(displayProperties).map(([key, value]) => (
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

export const SubflowNode = memo(function SubflowNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="subflow" selected={props.selected} />;
});

export const ResourceNode = memo(function ResourceNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="resource" selected={props.selected} />;
});

export const SignalNode = memo(function SignalNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="signal" selected={props.selected} />;
});
