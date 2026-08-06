import React, { memo, useContext, useEffect, useRef, useState } from 'react';
import { 
  Handle, 
  Position, 
  NodeProps,
  Connection,
  NodeToolbar,
} from '@xyflow/react';
import { alpha, styled, useTheme } from '@mui/material/styles';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Paper,
  Typography,
  Box,
  IconButton,
} from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import SettingsIcon from '@mui/icons-material/Settings';
import OutputIcon from '@mui/icons-material/Output';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import DescriptionIcon from '@mui/icons-material/Description';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import BoltIcon from '@mui/icons-material/Bolt';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import type { NodeType } from '@/frontend/types/flow/flow';
import { flowNodeColors, flowNodeLightColors } from '@/frontend/utils/flowPaletteTokens';
import { buildNodeInformation } from './nodeInformation';
import { FlowNamesContext } from './flowNamesContext';
import { useI18n } from '@/frontend/contexts/I18nContext';

// Resource, signal, and trigger nodes use shared semantic tokens because the
// MUI palette slots are already occupied by the other FlowBuilder node types.
export const RESOURCE_COLOR = flowNodeColors.light.resource;
const RESOURCE_COLOR_LIGHT = flowNodeLightColors.resource;

export const SIGNAL_COLOR = flowNodeColors.light.signal;
const SIGNAL_COLOR_LIGHT = flowNodeLightColors.signal;

export const TRIGGER_COLOR = flowNodeColors.light.trigger;
export const TRIGGER_COLOR_LIGHT = flowNodeLightColors.trigger;

export const STATIC_COLOR = flowNodeColors.light.static;
export const STATIC_COLOR_LIGHT = flowNodeLightColors.static;

// One authority for per-type node colors instead of five repeated ternary
// chains. `main` styles borders/icons; `light` styles the header divider.
const NODE_TYPE_COLORS: Record<NodeType, { main: (theme: any) => string; light: (theme: any) => string }> = {
  start: { main: () => flowNodeColors.light.start, light: () => flowNodeColors.dark.start },
  process: { main: (t) => t.palette.primary.main, light: (t) => t.palette.primary.light },
  finish: { main: (t) => t.palette.success.main, light: (t) => t.palette.success.light },
  mcp: { main: (t) => t.palette.info.main, light: (t) => t.palette.info.light },
  subflow: { main: (t) => t.palette.warning.main, light: (t) => t.palette.warning.light },
  resource: { main: () => RESOURCE_COLOR, light: () => RESOURCE_COLOR_LIGHT },
  signal: { main: () => SIGNAL_COLOR, light: () => SIGNAL_COLOR_LIGHT },
  trigger: { main: () => TRIGGER_COLOR, light: () => TRIGGER_COLOR_LIGHT },
  static: { main: () => STATIC_COLOR, light: () => STATIC_COLOR_LIGHT },
};

const nodeMainColor = (type: NodeType, theme: any) => (NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.start).main(theme);
const nodeLightColor = (type: NodeType, theme: any) => (NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.start).light(theme);

const NodeContainer = styled(Paper, {
  shouldForwardProp: (prop) => !['nodeType', 'selected'].includes(prop as string),
})<{
  nodeType: NodeType;
  selected?: boolean;
}>(({ theme, nodeType, selected }) => ({
  padding: theme.spacing(1.6),
  // Fixed (not min) width so every node is the same size: with equal widths and
  // grid snapping, node centers line up vertically, so top/bottom handles align
  // and edges run straight instead of jogging "around the corner".
  width: '210px',
  position: 'relative',
  overflow: 'visible',
  borderRadius: '16px',
  backgroundColor: theme.palette.background.paper,
  backgroundImage: `linear-gradient(145deg, ${alpha(nodeMainColor(nodeType, theme), 0.08)}, transparent 42%)`,
  border: `1px solid ${theme.palette.divider}`,
  borderLeft: `3px solid ${nodeMainColor(nodeType, theme)}`,
  boxShadow: selected
    ? `0 0 0 3px ${alpha(theme.palette.secondary.main, 0.28)}, 0 18px 45px ${alpha(nodeMainColor(nodeType, theme), 0.18)}`
    : `0 12px 34px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.28 : 0.1)}`,
  transition: 'transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease',
  '&:hover': {
    borderColor: alpha(nodeMainColor(nodeType, theme), 0.58),
    boxShadow: `0 0 0 1px ${alpha(nodeMainColor(nodeType, theme), 0.35)}, 0 18px 45px ${alpha(nodeMainColor(nodeType, theme), 0.16)}`,
    transform: 'translateY(-2px)',
  },
  // Keep the visible connector compact while giving fingers and slightly
  // imprecise mouse drops a much larger interactive target.
  '& .react-flow__handle::after': {
    content: '""',
    position: 'absolute',
    inset: -8,
    borderRadius: '50%',
  },
  '@media (pointer: coarse)': {
    '& .react-flow__handle::after': {
      inset: -14,
    },
  },
}));

const NodeHeader = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'nodeType',
})<{ nodeType: NodeType }>(({ theme, nodeType }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: `1px solid ${alpha(nodeLightColor(nodeType, theme), 0.28)}`,
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

interface CustomNodeProps extends NodeProps {
  nodeType: NodeType;
}

export const FLOW_QUICK_CONNECT_EVENT = 'flowQuickConnect';
export type QuickConnectSide = 'top' | 'right' | 'bottom' | 'left';
export interface FlowQuickConnectEventDetail {
  nodeId: string;
  handleId: string;
  side: QuickConnectSide;
  clientX: number;
  clientY: number;
}

interface QuickConnectHandle {
  handleId: string;
  side: QuickConnectSide;
  /** Separates multiple semantic handles that share the same node side. */
  align?: 'start' | 'center' | 'end';
  /** Pins a control beside a semantic handle instead of a node corner. */
  anchor?: string;
}

// Only handles that can create a valid new neighbor get a quick-connect control.
// Target-only flow handles stay drag targets, and MCP nodes themselves never
// offer add-and-connect controls.
const QUICK_CONNECT_HANDLES: Record<NodeType, QuickConnectHandle[]> = {
  start: [{ handleId: 'start-bottom', side: 'bottom' }],
  process: [
    { handleId: 'process-bottom', side: 'bottom' },
    { handleId: 'process-left-mcp', side: 'left', anchor: '30%' },
    { handleId: 'process-right-mcp', side: 'right', anchor: '30%' },
    { handleId: 'process-left-resource', side: 'left', anchor: '70%' },
    { handleId: 'process-right-resource', side: 'right', anchor: '70%' },
  ],
  finish: [],
  mcp: [],
  subflow: [{ handleId: 'subflow-bottom', side: 'bottom' }],
  resource: [{ handleId: 'resource-out', side: 'right' }],
  signal: [{ handleId: 'signal-bottom', side: 'bottom' }],
  trigger: [{ handleId: 'trigger-bottom', side: 'bottom' }],
  static: [{ handleId: 'static-bottom', side: 'bottom' }],
};

const quickConnectRotation: Record<QuickConnectSide, number> = {
  top: -90,
  right: 0,
  bottom: 90,
  left: 180,
};

const getNodeIcon = (type: NodeType) => {
  switch (type) {
    case 'start':
      return <ChatIcon sx={{ color: '#7E889E' }} />;
    case 'process':
      return <SettingsIcon color="primary" />;
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
    case 'trigger':
      return <BoltIcon sx={{ color: TRIGGER_COLOR }} />;
    case 'static':
      // Static node (issue #358): pre-authored conversation content.
      return <NoteAddIcon sx={{ color: STATIC_COLOR }} />;
    default:
      return <ChatIcon sx={{ color: '#7E889E' }} />;
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
  backgroundColor: theme.palette.primary.main,
  borderColor: theme.palette.mode === 'dark' ? theme.palette.background.paper : 'white',
  width: 16,
  height: 16,
  borderRadius: 8,
  borderWidth: 2
});

const getMCPConnectionHandleStyle = (theme: any) => ({
  backgroundColor: theme.palette.info.main,
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

const CustomNode = ({ id, data, nodeType, selected }: CustomNodeProps & { selected?: boolean }) => {
  const theme = useTheme();
  const { t, tp, formatList } = useI18n();
  const flowNames = useContext(FlowNamesContext);
  const [expanded, setExpanded] = useState(false);
  const [hoverReady, setHoverReady] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const information = buildNodeInformation(data, nodeType, { t, tp, formatList }, flowNames);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  // Selection opens the inspector; it must not also pin the transient
  // add-and-connect controls around the node.
  useEffect(() => {
    if (!selected) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hoverTimerRef.current = null;
    hideTimerRef.current = null;
    setHoverReady(false);
  }, [selected]);

  const startHoverReveal = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    if (selected || hoverReady || hoverTimerRef.current) return;
    hoverTimerRef.current = setTimeout(() => {
      setHoverReady(true);
      hoverTimerRef.current = null;
    }, 450);
  };

  const stopHoverReveal = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    if (selected) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setHoverReady(false);
      hideTimerRef.current = null;
    }, 180);
  };

  const requestQuickConnect = (
    event: React.MouseEvent<HTMLButtonElement>,
    quickConnect: QuickConnectHandle,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent<FlowQuickConnectEventDetail>(FLOW_QUICK_CONNECT_EVENT, {
      detail: {
        nodeId: id,
        handleId: quickConnect.handleId,
        side: quickConnect.side,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      },
    }));
  };

  const stopNodeInteraction = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const handleDetailsChange = (event: React.SyntheticEvent, isExpanded: boolean) => {
    event.stopPropagation();
    setExpanded(isExpanded);
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

          {/* Resource connection connectors (left/right, lower). Both are
              `source` so a producer edge (Process → Resource) can be drawn from
              EITHER side — issue #210. Direction (produce vs consume) follows
              which end the drag starts from, and the canvas runs in
              ConnectionMode.Loose so a source handle may still be the drop
              target of a consume drag (resource-out → here). Handle IDs are
              unchanged, so existing saved flows keep rendering as-is. */}
          <Handle
            id="process-left-resource"
            type="source"
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
      // Start nodes have a bottom connector (to the rest of the flow) and
      // a top target handle so a Trigger node can connect into it (issue #241).
      return (
        <>
          <Handle
            id="start-top"
            type="target"
            position={Position.Top}
            style={getProcessHandleStyle(theme)}
          />
          <Handle
            id="start-bottom"
            type="source"
            position={Position.Bottom}
            style={getProcessHandleStyle(theme)}
          />
        </>
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
    } else if (nodeType === 'static') {
      // Static nodes (issue #358) sit inline like a signal node: in from above,
      // out below. They inject pre-authored messages and pass through.
      return (
        <>
          <Handle
            id="static-top"
            type="target"
            position={Position.Top}
            style={getProcessHandleStyle(theme)}
          />
          <Handle
            id="static-bottom"
            type="source"
            position={Position.Bottom}
            style={getProcessHandleStyle(theme)}
          />
        </>
      );
    } else if (nodeType === 'trigger') {
      // Trigger nodes (issue #241) sit ABOVE the Start node. They have only a
      // bottom source handle — the edge flows Trigger → Start.
      return (
        <Handle
          id="trigger-bottom"
          type="source"
          position={Position.Bottom}
          style={{ ...getProcessHandleStyle(theme), backgroundColor: TRIGGER_COLOR }}
        />
      );
    }

    return null;
  };
  
  return (
    <>
      <NodeContainer
        elevation={2}
        nodeType={nodeType}
        selected={selected}
        onMouseEnter={startHoverReveal}
        onMouseLeave={stopHoverReveal}
      >
        {renderHandles()}
        {QUICK_CONNECT_HANDLES[nodeType].map((quickConnect) => {
          const label = t('flows.canvas.quickConnect', {
            node: information.label,
            side: t(`flows.canvas.side.${quickConnect.side}`),
          });
          const isToolHandle = quickConnect.handleId.includes('-mcp');
          const isResourceHandle = quickConnect.handleId.includes('-resource');
          const controlColor = isToolHandle
            ? theme.palette.info.main
            : isResourceHandle
              ? RESOURCE_COLOR
              : theme.palette.primary.main;
          const control = (
            <IconButton
              className="nodrag nopan"
              size="small"
              aria-label={label}
              title={label}
              onPointerDown={stopNodeInteraction}
              onClick={(event) => requestQuickConnect(event, quickConnect)}
              sx={{
                width: 32,
                height: 32,
                p: 0,
                color: theme.palette.getContrastText(controlColor),
                bgcolor: controlColor,
                border: '2px solid',
                borderColor: 'background.paper',
                boxShadow: 3,
                transition: 'transform 140ms ease, filter 140ms ease',
                '&:hover, &:focus-visible': {
                  bgcolor: controlColor,
                  filter: 'brightness(0.9)',
                  transform: 'scale(1.08)',
                },
              }}
            >
              {isToolHandle ? (
                <BuildRoundedIcon sx={{ fontSize: 17 }} />
              ) : isResourceHandle ? (
                <DescriptionIcon sx={{ fontSize: 18 }} />
              ) : (
                <PlayArrowRoundedIcon
                  sx={{ fontSize: 19, transform: `rotate(${quickConnectRotation[quickConnect.side]}deg)` }}
                />
              )}
            </IconButton>
          );

          if (nodeType === 'process' && quickConnect.anchor) {
            if (!hoverReady) return null;
            return (
              <Box
                key={quickConnect.handleId}
                onMouseEnter={startHoverReveal}
                onMouseLeave={stopHoverReveal}
                sx={{
                  position: 'absolute',
                  top: quickConnect.anchor,
                  ...(quickConnect.side === 'left' ? { left: -50 } : { right: -50 }),
                  transform: 'translateY(-50%)',
                  zIndex: 5,
                }}
              >
                {control}
              </Box>
            );
          }

          return (
            <NodeToolbar
              key={quickConnect.handleId}
              nodeId={id}
              isVisible={hoverReady}
              position={Position[quickConnect.side.charAt(0).toUpperCase() + quickConnect.side.slice(1) as keyof typeof Position]}
              align={quickConnect.align ?? 'center'}
              offset={10}
              onMouseEnter={startHoverReveal}
              onMouseLeave={stopHoverReveal}
            >
              {control}
            </NodeToolbar>
          );
        })}
        
        <NodeHeader nodeType={nodeType}>
          <NodeContent>
            {getNodeIcon(nodeType)}
            <Typography variant="subtitle2" fontWeight="bold">
              {information.label}
            </Typography>
          </NodeContent>
        </NodeHeader>

        {information.summary.length > 0 && (
          <NodeDetails aria-label={t('flows.nodeInfo.summary')}>
            {information.summary.map((entry) => (
              <Box key={entry.key} sx={{ mb: 0.5 }}>
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ fontWeight: 'bold', mr: 0.5 }}
                >
                  {entry.label}:
                </Typography>
                <Typography
                  component="span"
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    whiteSpace: entry.multiline ? 'pre-line' : 'normal',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {entry.value}
                </Typography>
              </Box>
            ))}
          </NodeDetails>
        )}

        <Accordion
          disableGutters
          elevation={0}
          expanded={expanded}
          onChange={handleDetailsChange}
          onClick={stopNodeInteraction}
          onPointerDown={stopNodeInteraction}
          className="nodrag nowheel"
          sx={{
            mt: 1,
            backgroundColor: 'transparent',
            '&::before': { display: 'none' },
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon fontSize="small" />}
            aria-controls={`${id}-technical-details`}
            sx={{
              minHeight: 28,
              px: 0,
              '& .MuiAccordionSummary-content': { my: 0.25 },
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {t('flows.nodeInfo.technical')}
            </Typography>
          </AccordionSummary>
          <AccordionDetails
            id={`${id}-technical-details`}
            sx={{ p: 0 }}
          >
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1,
                maxHeight: 220,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontSize: '0.7rem',
                lineHeight: 1.35,
                backgroundColor: 'action.hover',
                borderRadius: 1,
              }}
            >
              {information.technicalText}
            </Box>
          </AccordionDetails>
        </Accordion>
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

export const TriggerNode = memo(function TriggerNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="trigger" selected={props.selected} />;
});

export const StaticNode = memo(function StaticNode(props: NodeProps) {
  return <CustomNode {...props} nodeType="static" selected={props.selected} />;
});
