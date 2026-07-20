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
import { ConversationListItem } from './index'; // Import ConversationListItem instead
import { isQuickChatFlowId } from '@/utils/shared/quickChat';
import { recencyBucket } from '@/utils/shared/flowGrouping';
import { groupItems, CardGroup } from '@/utils/shared/cardGrouping';
import { buildWaveLookup, waveBucket, orderWaveGroups } from '@/utils/shared/waveGrouping';
import type { WavesResponse } from '@/shared/types/waves/waves';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';

interface ChatHistoryProps {
  conversations: ConversationListItem[]; // Use ConversationListItem[]
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
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

type GroupMode = 'none' | 'date' | 'flow' | 'wave';
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
  { value: 'flow', label: 'Group by flow' },
  { value: 'wave', label: 'Group by wave' },
];

const ChatHistory: React.FC<ChatHistoryProps> = ({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onStopConversation,
  onNewConversation,
  onQuickChat,
  onCollapse,
  flowNames = {},
}) => {
  // Search text is intentionally ephemeral (not persisted): a stale filter
  // silently hiding conversations after a reload would be surprising.
  const [search, setSearch] = React.useState('');
  const [groupMode, setGroupMode] = useUiPreference<GroupMode>(PREF.group, 'none');
  const [statusFilter, setStatusFilter] = useUiPreference<StatusFilter>(PREF.status, 'all');
  const [flowFilter, setFlowFilter] = useUiPreference<string>(PREF.flow, 'all');
  const [dateFilter, setDateFilter] = useUiPreference<DateFilter>(PREF.date, 'all');
  const [collapsedGroups, setCollapsedGroups] = useUiPreference<Record<string, boolean>>(
    PREF.collapsed,
    {},
  );

  // Wave grouping (issue #181): the wave graph is only needed while grouping by
  // wave, so fetch it lazily and refresh it when the conversation list changes
  // (the sidebar polls periodically). Failures / empty responses are tolerated
  // silently — grouping just falls back to the Ad-hoc / Archived buckets.
  const [waves, setWaves] = React.useState<WavesResponse | null>(null);
  React.useEffect(() => {
    if (groupMode !== 'wave') return;
    let cancelled = false;
    fetch('/api/waves')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setWaves(data as WavesResponse); })
      .catch(() => { /* ignore — sidebar still renders fallback buckets */ });
    return () => { cancelled = true; };
  }, [groupMode, conversations]);

  const waveLookup = useMemo(() => buildWaveLookup(waves), [waves]);

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
      if (!flowId) return { key: 'flow:__none__', label: 'No flow' };
      if (isQuickChatFlowId(flowId)) return { key: 'flow:__quickchat__', label: 'Quick Chat' };
      return { key: `flow:${flowId}`, label: flowNames[flowId] ?? 'Unknown flow' };
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
          const haystack = `${c.title} ${flowMeta(c.flowId).label}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations, search, statusFilter, flowFilter, dateFilter, flowMeta]);

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
    return groupItems(filtered, (c) =>
      groupMode === 'date' ? recencyBucket(c.updatedAt) : flowMeta(c.flowId),
    );
  }, [filtered, groupMode, flowMeta, waveLookup]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
    return (
      <ListItem
        key={conversation.id}
        disablePadding
        secondaryAction={
          <>
            {stoppable && (
              <Tooltip title="Stop this run">
                <IconButton
                  edge="end"
                  aria-label="stop run"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStopConversation!(conversation.id);
                  }}
                >
                  <StopCircleIcon color="error" />
                </IconButton>
              </Tooltip>
            )}
            <IconButton
              edge="end"
              aria-label="delete"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteConversation(conversation.id);
              }}
            >
              <DeleteIcon />
            </IconButton>
          </>
        }
        sx={{
          opacity: conversation.id === currentConversationId ? 1 : 0.7,
        }}
      >
        <ListItemButton
          selected={conversation.id === currentConversationId}
          onClick={() => onSelectConversation(conversation.id)}
          sx={{ pr: stoppable ? 12 : 7 }} // Make room for the action buttons
        >
          <ListItemText
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
                        display: 'inline-block',
                        flexShrink: 0
                      }}
                    />
                  </Tooltip>
                )}
                <Tooltip title={conversation.title} enterDelay={500}>
                  <Typography
                    component="span"
                    fontWeight={conversation.id === currentConversationId ? 'bold' : 'normal'}
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
                sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5, flexWrap: 'wrap' }}
              >
                {/* Which flow this conversation used (issue #147) — hidden when
                    grouping by flow to avoid redundancy with the section header. */}
                {groupMode !== 'flow' && (
                  <Tooltip title={isQuickChat ? 'Quick Chat (no saved flow)' : `Flow: ${meta.label}`}>
                    <Chip
                      icon={isQuickChat ? <BoltIcon /> : undefined}
                      label={meta.label}
                      size="small"
                      variant="outlined"
                      color={isQuickChat ? 'secondary' : 'default'}
                      sx={{ maxWidth: '100%', height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }}
                    />
                  </Tooltip>
                )}
                <Typography component="span" variant="caption" color="text.secondary">
                  {formatDate(conversation.updatedAt)}
                </Typography>
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
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
        {onCollapse && (
          <Tooltip title="Hide sidebar">
            <IconButton size="small" onClick={onCollapse} aria-label="Hide conversation sidebar">
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
        )}
        <Typography variant="h6" sx={{ flex: 1 }} noWrap>Conversations</Typography>
        {onQuickChat && (
          <Tooltip title="Quick Chat: a model + optional MCP servers, no saved flow">
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
      <Box sx={{ px: 2, pt: 1.5, pb: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search title or flow…"
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
              aria-label="Filter by flow"
            >
              <MenuItem value="all">Any flow</MenuItem>
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

      <List sx={{ overflow: 'auto', flex: 1 }}>
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
        ) : groupMode === 'none' ? (
          filtered.map(renderConversation)
        ) : (
          groups.map((group) => {
            const collapsed = !!collapsedGroups[group.key];
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
                  {group.items.map(renderConversation)}
                </Collapse>
              </Box>
            );
          })
        )}
      </List>
    </>
  );
};

export default ChatHistory;
