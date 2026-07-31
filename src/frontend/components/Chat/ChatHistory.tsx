"use client";

import React, { useMemo } from 'react';
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Typography,
  Divider,
  Button,
  Tooltip,
  TextField,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  Chip,
  Collapse,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import BoltIcon from '@mui/icons-material/Bolt';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import WebhookRoundedIcon from '@mui/icons-material/WebhookRounded';
import ApiRoundedIcon from '@mui/icons-material/ApiRounded';
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded';
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded';
import { ConversationListItem } from './index'; // Import ConversationListItem instead
import { isQuickChatFlowId } from '@/utils/shared/quickChat';
import { recencyBucket } from '@/utils/shared/flowGrouping';
import { groupItems, CardGroup } from '@/utils/shared/cardGrouping';
import {
  buildWaveLookup,
  waveBucket,
  orderWaveGroups,
} from '@/utils/shared/waveGrouping';
import type { WavesResponse } from '@/shared/types/waves/waves';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import ConversationTree from './ConversationTree';
import { buildChainIndex } from '@/utils/shared/conversationChains';
import { alpha, useTheme as useMuiTheme } from '@mui/material/styles';
import { useTheme as useAppTheme } from '@/frontend/contexts/ThemeContext';
import { getConversationOrigin } from './conversationOrigin';
import type { ConversationOriginKey } from './conversationOrigin';

interface ChatHistoryProps {
  conversations: ConversationListItem[]; // Use ConversationListItem[]
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Bulk-delete a set of conversations by id (Delete All / Delete Visible). */
  onBulkDelete: (ids: string[]) => Promise<void>;
  /** Stop the run of a conversation that is running or awaiting tool approval.
   *  Rendered as a stop button on those list items — including background
   *  conversations, which otherwise have no reachable Stop at all. */
  onStopConversation?: (id: string) => void;
  onNewConversation: () => void;
  /** Start a Quick Chat (model + optional MCP servers, no saved flow) — issue #61. */
  onQuickChat?: () => void;
  /** Optional: collapse/hide the sidebar. When provided, a toggle button is
   *  rendered next to the header. State is owned by the parent. */
  onCollapse?: () => void;
  /** Map of flowId → flow name, so the sidebar can show which flow each
   *  conversation used (issue #147). Quick-chat pseudo-flows are detected from
   *  their id and labelled "Quick Chat" regardless of this map. */
  flowNames?: Record<string, string>;
}

type GroupMode = 'none' | 'date' | 'flow' | 'origin' | 'wave' | 'chain';
type StatusFilter = 'all' | NonNullable<ConversationListItem['status']>;
type DateFilter = 'all' | 'today' | '7d' | '30d';

// Persisted per-browser UI preferences (issue #147). Namespaced with the app's
// existing `flujo-ui:` convention so they sit alongside the other list-surface
// preferences (flows/models/mcp sort + fold state).
const PREF = {
  group: 'flujo-ui:chat-sidebar:group',
  status: 'flujo-ui:chat-sidebar:status',
  flow: 'flujo-ui:chat-sidebar:flow',
  date: 'flujo-ui:chat-sidebar:date',
  collapsed: 'flujo-ui:chat-sidebar:collapsed',
  searchDim: 'flujo-ui:chat-sidebar:search-dim',
} as const;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Any status' },
  { value: 'running', label: 'Processing' },
  { value: 'awaiting_tool_approval', label: 'Awaiting approval' },
  { value: 'paused_debug', label: 'Paused (debug)' },
  { value: 'completed', label: 'Completed' },
  { value: 'error', label: 'Error' },
];

const DATE_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: 'today', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const GROUP_OPTIONS: { value: GroupMode; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'date', label: 'Group by date' },
  { value: 'flow', label: 'Group by agent' },
  { value: 'origin', label: 'Group by origin' },
  { value: 'wave', label: 'Group by wave' },
  { value: 'chain', label: 'Group by chain' },
];

const ORIGIN_ICONS: Record<ConversationOriginKey, React.ElementType> = {
  chat: ChatBubbleOutlineRoundedIcon,
  api: ApiRoundedIcon,
  schedule: ScheduleRoundedIcon,
  trigger: WebhookRoundedIcon,
  subflow: AccountTreeRoundedIcon,
  mcp: ExtensionRoundedIcon,
  internal: AutoAwesomeRoundedIcon,
  unknown: HelpOutlineRoundedIcon,
};

const ORIGIN_COLORS = {
  chat: 'primary',
  api: 'info',
  schedule: 'secondary',
  trigger: 'warning',
  subflow: 'success',
  mcp: 'info',
  internal: 'secondary',
  unknown: 'default',
} as const satisfies Record<ConversationOriginKey, 'primary' | 'info' | 'secondary' | 'warning' | 'success' | 'default'>;

const originCardColor = (
  key: ConversationOriginKey,
  theme: ReturnType<typeof useMuiTheme>,
): string => {
  switch (key) {
    case 'chat': return theme.palette.primary.main;
    case 'api':
    case 'mcp': return theme.palette.info.main;
    case 'schedule':
    case 'internal': return theme.palette.secondary.main;
    case 'trigger': return theme.palette.warning.main;
    case 'subflow': return theme.palette.success.main;
    default: return theme.palette.text.secondary;
  }
};

const ChatHistory: React.FC<ChatHistoryProps> = ({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onBulkDelete,
  onStopConversation,
  onNewConversation,
  onQuickChat,
  onCollapse,
  flowNames = {},
}) => {
  const muiTheme = useMuiTheme();
  const { visualStyle } = useAppTheme();
  const modern = visualStyle === 'modern';
  // Search text is intentionally ephemeral (not persisted): a stale filter
  // silently hiding conversations after a reload would be surprising.
  const [search, setSearch] = React.useState('');
  // Confirmation dialog state for bulk delete (Delete All / Delete Visible).
  const [bulkDeleteDialog, setBulkDeleteDialog] = React.useState<{
    open: boolean; ids: string[]; label: string;
  }>({ open: false, ids: [], label: '' });
  // Search dimension (issue #182): 'title' filters client-side over titles+flow
  // (Phase 1); 'content' resolves matches server-side against message bodies
  // (which aren't all resident on the client). Persisted so the choice sticks.
  const [searchDimension, setSearchDimension] = useUiPreference<'title' | 'content'>(
    PREF.searchDim,
    'title',
  );
  // Ids the backend content-search matched; null while a request is in flight
  // (or when content search is inactive) so `filtered` shows nothing until the
  // result lands rather than flashing the whole list.
  const [contentMatchIds, setContentMatchIds] = React.useState<Set<string> | null>(null);
  const [groupMode, setGroupMode] = useUiPreference<GroupMode>(PREF.group, 'none');
  const [statusFilter, setStatusFilter] = useUiPreference<StatusFilter>(PREF.status, 'all');
  const [flowFilter, setFlowFilter] = useUiPreference<string>(PREF.flow, 'all');
  const [dateFilter, setDateFilter] = useUiPreference<DateFilter>(PREF.date, 'all');
  const [collapsedGroups, setCollapsedGroups] = useUiPreference<Record<string, boolean>>(
    PREF.collapsed,
    {},
  );

  // Wave grouping (issue #181): the wave graph is only needed while grouping by
  // wave, so fetch it lazily and refresh it when wave membership changes.
  // Status/title updates do not need another wave request. Failures are tolerated
  // silently — grouping just falls back to the Ad-hoc / Archived buckets.
  const [waves, setWaves] = React.useState<WavesResponse | null>(null);
  const waveMembershipKey = useMemo(
    () => conversations
      .map((conversation) => `${conversation.id}:${conversation.plannedExecutionId ?? ''}`)
      .join('\u0000'),
    [conversations],
  );
  React.useEffect(() => {
    if (groupMode !== 'wave') return;
    let cancelled = false;
    fetch('/api/waves')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setWaves(data as WavesResponse); })
      .catch(() => { /* ignore — sidebar still renders fallback buckets */ });
    return () => { cancelled = true; };
  }, [groupMode, waveMembershipKey]);

  const waveLookup = useMemo(() => buildWaveLookup(waves), [waves]);

  // Content search (issue #182): when the search dimension is 'content', message
  // bodies must be matched server-side (they aren't all resident here). Debounce
  // the request so a scan doesn't fire on every keystroke, and ignore stale
  // responses. Non-content mode clears the id set so `filtered` falls back to
  // the client-side title filter.
  React.useEffect(() => {
    const q = search.trim();
    if (searchDimension !== 'content' || q.length === 0) {
      setContentMatchIds(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/v1/chat/conversations?search=${encodeURIComponent(q)}&dimension=content`)
        .then((r) => (r.ok ? r.json() : []))
        .then((data: ConversationListItem[]) => {
          if (cancelled) return;
          setContentMatchIds(new Set(Array.isArray(data) ? data.map((c) => c.id) : []));
        })
        .catch(() => { if (!cancelled) setContentMatchIds(new Set()); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, searchDimension]);

  // Format date for display
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Get color based on conversation status
  const getStatusColor = (status?: ConversationListItem['status']) => {
    switch (status) {
      case 'running': return 'primary.main';
      case 'awaiting_tool_approval': return 'warning.main';
      case 'paused_debug': return 'secondary.main';
      case 'completed': return 'success.main';
      case 'capped': return 'info.main';
      case 'error': return 'error.main';
      default: return 'transparent';
    }
  };

  // Get status description for tooltip
  const getStatusDescription = (status?: ConversationListItem['status']) => {
    switch (status) {
      case 'running': return 'Processing';
      case 'awaiting_tool_approval': return 'Waiting for tool approval';
      case 'paused_debug': return 'Paused in debug mode';
      case 'completed': return 'Completed';
      case 'capped': return 'Landed at turn limit (summary produced)';
      case 'error': return 'Error';
      default: return '';
    }
  };

  // Resolve a conversation's flow into a stable grouping key + display label.
  // Quick-chat snapshots share one bucket ("Quick Chat"); a flowId not present
  // in the loaded flows map (e.g. a since-deleted flow) is shown as "Unknown
  // flow" rather than dropped, so the conversation stays discoverable.
  const flowMeta = React.useCallback(
    (flowId: string | null): { key: string; label: string } => {
      if (!flowId) return { key: 'flow:__none__', label: 'No agent' };
      if (isQuickChatFlowId(flowId)) return { key: 'flow:__quickchat__', label: 'Quick Chat' };
      return { key: `flow:${flowId}`, label: flowNames[flowId] ?? 'Unknown agent' };
    },
    [flowNames],
  );

  // Distinct flow options for the flow filter, derived from the conversations
  // actually present (deduped by grouping key), sorted A–Z by label.
  const flowOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) {
      const meta = flowMeta(c.flowId);
      if (!map.has(meta.key)) map.set(meta.key, meta.label);
    }
    return Array.from(map.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [conversations, flowMeta]);

  // Apply search + filters, then sort most-recent-first. Memoized so SSE-driven
  // re-renders of the parent don't re-run the whole pipeline needlessly.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const dateCutoff =
      dateFilter === 'today' ? now - DAY
      : dateFilter === '7d' ? now - 7 * DAY
      : dateFilter === '30d' ? now - 30 * DAY
      : 0;

    return conversations
      .filter((c) => {
        if (statusFilter !== 'all' && c.status !== statusFilter) return false;
        if (flowFilter !== 'all' && flowMeta(c.flowId).key !== flowFilter) return false;
        if (dateCutoff && c.updatedAt < dateCutoff) return false;
        if (q) {
          if (searchDimension === 'content') {
            // Content search is resolved server-side (issue #182). While the
            // debounced request is in flight (contentMatchIds === null) show no
            // matches yet; otherwise keep only the ids the backend matched.
            if (!contentMatchIds || !contentMatchIds.has(c.id)) return false;
          } else {
            const origin = getConversationOrigin(c);
            const haystack = `${c.title} ${flowMeta(c.flowId).label} ${origin.label}`.toLowerCase();
            if (!haystack.includes(q)) return false;
          }
        }
        return true;
      })
      .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
  }, [conversations, search, searchDimension, contentMatchIds, statusFilter, flowFilter, dateFilter, flowMeta]);

  // Build the (optionally grouped) sections to render.
  const groups: CardGroup<ConversationListItem>[] = useMemo(() => {
    if (groupMode === 'none') {
      return [{ key: 'all', label: '', items: filtered }];
    }
    if (groupMode === 'wave') {
      // Bucket by wave; keep the Ad-hoc / Archived fallback buckets last.
      return orderWaveGroups(
        groupItems(filtered, (c) => waveBucket(c.plannedExecutionId, waveLookup)),
      );
    }
    return groupItems(filtered, (c) => {
      if (groupMode === 'date') return recencyBucket(c.updatedAt);
      if (groupMode === 'origin') {
        const origin = getConversationOrigin(c);
        return { key: `origin:${origin.key}`, label: origin.label };
      }
      return flowMeta(c.flowId);
    });
  }, [filtered, groupMode, flowMeta, waveLookup]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // "By chain" grouping (issue #182): nest child conversations under the parent
  // that spawned them, using the persisted parentConversationId links. The
  // index is only built while that mode is active; a filter that hides a parent
  // but keeps a child renders the child as a root (see buildChainIndex).
  const chainIndex = useMemo(
    () => (groupMode === 'chain' ? buildChainIndex(filtered) : { roots: [], childrenByParent: new Map() }),
    [groupMode, filtered],
  );
  // Per-node expand state is session-only (not persisted): a node is expanded
  // unless explicitly collapsed, so chains are visible by default.
  const [expandedChains, setExpandedChains] = React.useState<Record<string, boolean>>({});
  const toggleChain = React.useCallback((id: string) => {
    setExpandedChains((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }));
  }, []);

  // Wave grouping hierarchy (issue #214): within each wave bucket, nest
  // conversations by their RUNTIME parent chain (the same `parentConversationId`
  // links "Group by chain" uses) so every execution *run* is its own node —
  // ap-01 run → ap-02 run → ap-03 run — instead of collapsing all runs onto the
  // single planned-execution node. The lineage is recorded by the scheduler
  // when a flow-event/signal fire threads the upstream run as parentRunId.
  // Reuses the chain tree's session-only, expanded-by-default toggle state.
  const waveChainByGroup = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildChainIndex>>();
    if (groupMode !== 'wave') return map;
    for (const g of groups) map.set(g.key, buildChainIndex(g.items));
    return map;
  }, [groupMode, groups]);

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (flowFilter !== 'all' ? 1 : 0) +
    (dateFilter !== 'all' ? 1 : 0);

  const renderConversation = (conversation: ConversationListItem) => {
    // Any conversation whose run is still alive — executing or holding
    // tool calls (awaiting approval) — gets a stop button, so a run can
    // be stopped without first switching to its conversation.
    const stoppable =
      !!onStopConversation &&
      (conversation.status === 'running' || conversation.status === 'awaiting_tool_approval');
    const meta = flowMeta(conversation.flowId);
    const isQuickChat = meta.key === 'flow:__quickchat__';
    const selected = conversation.id === currentConversationId;
    const origin = getConversationOrigin(conversation);
    const OriginIcon = ORIGIN_ICONS[origin.key];
    const originColor = originCardColor(origin.key, muiTheme);
    const originWash = muiTheme.palette.mode === 'dark' ? 0.14 : 0.1;

    return (
      <ListItem
        key={conversation.id}
        data-conversation-origin={origin.key}
        disablePadding
        secondaryAction={
          <Box
            className="conversation-card-actions"
            sx={modern ? {
              display: 'flex',
              gap: 0.25,
              opacity: selected ? 1 : 0,
              transition: 'opacity 160ms ease',
              bgcolor: alpha(muiTheme.palette.background.paper, 0.72),
              borderRadius: 2,
              backdropFilter: 'blur(12px)',
              '& .MuiIconButton-root': { width: 30, height: 30 },
            } : { display: 'flex' }}
          >
            {stoppable && (
              <Tooltip title="Stop this run">
                <IconButton
                  edge="end"
                  size="small"
                  aria-label="stop run"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStopConversation!(conversation.id);
                  }}
                >
                  <StopCircleIcon color="error" fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Delete conversation">
              <IconButton
                edge="end"
                size="small"
                aria-label="delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteConversation(conversation.id);
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        }
        sx={modern ? {
          position: 'relative',
          mb: 0.9,
          border: '1px solid',
          borderColor: selected
            ? alpha(originColor, 0.68)
            : alpha(originColor, 0.32),
          borderRadius: 2.5,
          overflow: 'hidden',
          opacity: 1,
          bgcolor: selected
            ? alpha(originColor, originWash + 0.07)
            : alpha(originColor, originWash),
          backgroundImage: `linear-gradient(135deg, ${alpha(originColor, selected ? 0.3 : 0.21)} 0%, ${alpha(originColor, selected ? 0.14 : 0.08)} 58%, ${alpha(muiTheme.palette.background.paper, muiTheme.palette.mode === 'dark' ? 0.58 : 0.68)} 100%)`,
          boxShadow: selected
            ? `0 10px 30px ${alpha(originColor, 0.24)}`
            : `0 5px 20px ${alpha(originColor, muiTheme.palette.mode === 'dark' ? 0.12 : 0.08)}`,
          transition: 'transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease',
          '&::before': {
            content: '""',
            position: 'absolute',
            inset: '10px auto 10px 0',
            width: selected ? 4 : 3,
            borderRadius: '0 4px 4px 0',
            bgcolor: originColor,
          },
          '&:hover': {
            transform: 'translateY(-1px)',
            borderColor: alpha(originColor, 0.58),
            boxShadow: `0 10px 28px ${alpha(originColor, muiTheme.palette.mode === 'dark' ? 0.2 : 0.14)}`,
            '& .conversation-card-actions': { opacity: 1 },
          },
          '&:focus-within .conversation-card-actions': { opacity: 1 },
          '@media (hover: none)': { '& .conversation-card-actions': { opacity: 1 } },
        } : {
          opacity: selected ? 1 : 0.7,
        }}
      >
        <ListItemButton
          selected={selected}
          onClick={() => onSelectConversation(conversation.id)}
          aria-label={`Open ${conversation.title}, origin: ${origin.label}`}
          sx={{
            pr: stoppable ? 12 : 7,
            px: modern ? 1.5 : 2,
            py: modern ? 1.25 : 1,
            alignItems: 'flex-start',
            borderRadius: 'inherit',
            '&.Mui-selected': { bgcolor: 'transparent' },
            '&.Mui-selected:hover': { bgcolor: alpha(muiTheme.palette.primary.main, 0.04) },
          }}
        >
          <ListItemText
            sx={{ my: 0, minWidth: 0 }}
            primary={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {conversation.status && (
                  <Tooltip title={getStatusDescription(conversation.status)}>
                    <Box
                      component="span"
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        bgcolor: getStatusColor(conversation.status),
                        boxShadow: modern
                          ? `0 0 0 4px ${alpha(muiTheme.palette.common.white, 0.04)}`
                          : 'none',
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                  </Tooltip>
                )}
                <Tooltip title={conversation.title} enterDelay={500}>
                  <Typography
                    component="span"
                    fontWeight={selected ? 760 : modern ? 650 : 'normal'}
                    sx={{
                      // Allow the title to wrap to two lines with an
                      // ellipsis (issue #134) instead of the old single-
                      // line clamp, so longer generated titles are
                      // readable; the tooltip shows the full title.
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word',
                      fontSize: modern ? '0.9rem' : undefined,
                      lineHeight: modern ? 1.35 : undefined,
                    }}
                  >
                    {conversation.title}
                  </Typography>
                </Tooltip>
              </Box>
            }
            secondary={
              <Box
                component="span"
                sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.8, flexWrap: 'wrap' }}
              >
                {groupMode !== 'origin' && (
                  <Tooltip
                    title={`${origin.description}${origin.inferred ? ' (inferred from legacy metadata)' : ''}`}
                  >
                    <Chip
                      icon={<OriginIcon />}
                      label={origin.label}
                      size="small"
                      variant="outlined"
                      color={ORIGIN_COLORS[origin.key]}
                      sx={{
                        height: modern ? 22 : 20,
                        bgcolor: modern ? alpha(originColor, 0.13) : undefined,
                        '& .MuiChip-icon': { fontSize: 14 },
                        '& .MuiChip-label': {
                          px: 0.75,
                          fontSize: '0.68rem',
                          fontWeight: modern ? 700 : 500,
                        },
                      }}
                    />
                  </Tooltip>
                )}
                {/* Which flow this conversation used (issue #147) — hidden when
                    grouping by flow to avoid redundancy with the section header. */}
                {groupMode !== 'flow' && (
                  <Tooltip title={isQuickChat ? 'Quick Chat (no saved agent)' : `Agent: ${meta.label}`}>
                    <Chip
                      icon={isQuickChat ? <BoltIcon /> : undefined}
                      label={meta.label}
                      size="small"
                      variant="outlined"
                      color={isQuickChat ? 'secondary' : 'default'}
                      sx={{
                        maxWidth: '100%',
                        height: modern ? 22 : 20,
                        '& .MuiChip-icon': { fontSize: 14 },
                        '& .MuiChip-label': { px: 0.75, fontSize: '0.68rem' },
                      }}
                    />
                  </Tooltip>
                )}
                <Box
                  component="span"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, ml: 'auto' }}
                >
                  {modern && (
                    <AccessTimeRoundedIcon
                      aria-hidden="true"
                      sx={{ fontSize: 13, color: 'text.disabled' }}
                    />
                  )}
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                    sx={{ whiteSpace: 'nowrap' }}
                  >
                    {formatDate(conversation.updatedAt)}
                  </Typography>
                </Box>
              </Box>
            }
            secondaryTypographyProps={{ component: 'div' }}
          />
        </ListItemButton>
      </ListItem>
    );
  };

  const totalCount = conversations.length;
  const matchCount = filtered.length;

  return (
    <>
      <Box
        sx={{
          p: modern ? 2 : 1.5,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: modern ? 1 : 0.7,
          background: modern
            ? `linear-gradient(135deg, ${alpha(muiTheme.palette.primary.main, 0.14)}, ${alpha(muiTheme.palette.secondary.main, 0.05)} 58%, transparent)`
            : 'linear-gradient(120deg, rgba(139,124,255,.09), transparent 62%)',
        }}
      >
        {onCollapse && (
          <Tooltip title="Hide sidebar">
            <IconButton size="small" onClick={onCollapse} aria-label="Hide conversation sidebar">
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" sx={{ display: 'block', color: 'primary.light', fontWeight: 760, letterSpacing: '.1em' }}>
            AGENT RUNS
          </Typography>
          <Typography variant="h6" noWrap>Conversations</Typography>
        </Box>
        {conversations.length > 0 && (
          <Tooltip title="Delete all conversations">
            <span>{/* span wrapper needed for Tooltip on (potentially) disabled buttons */}
              <IconButton
                size="small"
                color="error"
                aria-label="Delete all conversations"
                onClick={() => setBulkDeleteDialog({
                  open: true,
                  ids: conversations.map(c => c.id),
                  label: `Delete all ${conversations.length} conversation(s)?`,
                })}
              >
                <DeleteForeverIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {filtered.length > 0 && filtered.length < conversations.length && (
          <Tooltip title="Delete visible conversations (matching current filter)">
            <span>
              <IconButton
                size="small"
                color="error"
                aria-label="Delete visible conversations"
                onClick={() => setBulkDeleteDialog({
                  open: true,
                  ids: filtered.map(c => c.id),
                  label: `Delete ${filtered.length} visible conversation(s)?`,
                })}
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {onQuickChat && (
          <Tooltip title="Quick Chat: a model + optional connected apps, no saved agent">
            <Button
              variant="outlined"
              color="primary"
              startIcon={<BoltIcon />}
              onClick={onQuickChat}
              size="small"
            >
              Quick
            </Button>
          </Tooltip>
        )}
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddIcon />}
          onClick={onNewConversation}
          size="small"
        >
          New
        </Button>
      </Box>

      <Divider />

      {/* Search + filter + group controls (issue #147). */}
      <Box
        sx={{
          px: 1.5,
          pt: 1.5,
          pb: 1.2,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          bgcolor: modern ? alpha(muiTheme.palette.background.paper, 0.22) : 'rgba(127,127,160,.035)',
        }}
      >
        <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField
          size="small"
          sx={{ flex: 1 }}
          placeholder={searchDimension === 'content' ? 'Search message content…' : 'Search title, origin or agent…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: search ? (
              <InputAdornment position="end">
                <IconButton size="small" aria-label="Clear search" onClick={() => setSearch('')}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : undefined,
          }}
        />
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <Select
            value={searchDimension}
            onChange={(e) => setSearchDimension(e.target.value as 'title' | 'content')}
            aria-label="Search dimension"
          >
            <MenuItem value="title">Title</MenuItem>
            <MenuItem value="content">Content</MenuItem>
          </Select>
        </FormControl>
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={groupMode}
              onChange={(e) => setGroupMode(e.target.value as GroupMode)}
              aria-label="Group conversations"
            >
              {GROUP_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="Filter by status"
            >
              {STATUS_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={flowOptions.some((o) => o.key === flowFilter) ? flowFilter : 'all'}
              onChange={(e) => setFlowFilter(e.target.value)}
              aria-label="Filter by agent"
            >
              <MenuItem value="all">Any agent</MenuItem>
              {flowOptions.map((o) => (
                <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value as DateFilter)}
              aria-label="Filter by date"
            >
              {DATE_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        {(search || activeFilterCount > 0) && (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">
              {matchCount} of {totalCount}
            </Typography>
            <Button
              size="small"
              onClick={() => {
                setSearch('');
                setStatusFilter('all');
                setFlowFilter('all');
                setDateFilter('all');
              }}
            >
              Clear filters
            </Button>
          </Box>
        )}
      </Box>

      <Divider />

      <List
        aria-label="Conversations"
        sx={{
          overflow: 'auto',
          flex: 1,
          px: modern ? 1.25 : 1,
          py: modern ? 1.5 : 1,
          scrollbarGutter: 'stable',
        }}
      >
        {totalCount === 0 ? (
          <ListItem>
            <ListItemText
              primary="No conversations yet"
              secondary="Start a new conversation"
              primaryTypographyProps={{ align: 'center' }}
              secondaryTypographyProps={{ align: 'center' }}
            />
          </ListItem>
        ) : matchCount === 0 ? (
          <ListItem>
            <ListItemText
              primary="No matching conversations"
              secondary="Try a different search or filter"
              primaryTypographyProps={{ align: 'center' }}
              secondaryTypographyProps={{ align: 'center' }}
            />
          </ListItem>
        ) : groupMode === 'chain' ? (
          <ConversationTree
            nodes={chainIndex.roots}
            childrenByParent={chainIndex.childrenByParent}
            renderItem={(c) => renderConversation(c)}
            expanded={expandedChains}
            onToggle={toggleChain}
          />
        ) : groupMode === 'none' ? (
          filtered.map(renderConversation)
        ) : (
          groups.map((group) => {
            const collapsed = !!collapsedGroups[group.key];
            // In wave mode, each bucket nests its conversations by their runtime
            // parent chain so every execution run is its own tree node (#214).
            const waveChain = groupMode === 'wave' ? waveChainByGroup.get(group.key) : undefined;
            return (
              <Box key={group.key}>
                <ListItemButton
                  onClick={() => toggleGroup(group.key)}
                  sx={{ py: 0.5, bgcolor: 'action.hover' }}
                >
                  {collapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
                  <Typography
                    variant="overline"
                    sx={{ ml: 0.5, flex: 1, lineHeight: 1.6 }}
                    noWrap
                  >
                    {group.label}
                  </Typography>
                  <Chip label={group.items.length} size="small" sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }} />
                </ListItemButton>
                <Collapse in={!collapsed} timeout="auto" unmountOnExit>
                  {waveChain ? (
                    <ConversationTree
                      nodes={waveChain.roots}
                      childrenByParent={waveChain.childrenByParent}
                      renderItem={(c) => renderConversation(c)}
                      expanded={expandedChains}
                      onToggle={toggleChain}
                    />
                  ) : (
                    group.items.map(renderConversation)
                  )}
                </Collapse>
              </Box>
            );
          })
        )}
      </List>

      <Dialog
        open={bulkDeleteDialog.open}
        onClose={() => setBulkDeleteDialog(prev => ({ ...prev, open: false }))}
        aria-labelledby="bulk-delete-dialog-title"
      >
        <DialogTitle id="bulk-delete-dialog-title">Confirm deletion</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {bulkDeleteDialog.label} This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkDeleteDialog(prev => ({ ...prev, open: false }))}>
            Cancel
          </Button>
          <Button
            color="error"
            onClick={async () => {
              setBulkDeleteDialog(prev => ({ ...prev, open: false }));
              await onBulkDelete(bulkDeleteDialog.ids);
            }}
            autoFocus
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

// The parent chat updates on every streamed message/debug event. Keeping this
// subtree memoized prevents rebuilding and reconciling the entire sidebar when
// its summaries and controls have not changed.
export default React.memo(ChatHistory);
