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
  CircularProgress,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import BoltIcon from '@mui/icons-material/Bolt';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
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
import LinkOffRoundedIcon from '@mui/icons-material/LinkOffRounded';
import { ConversationListItem } from './index'; // Import ConversationListItem instead
import type { ChatRevealRequest } from './index';
import { isQuickChatFlowId } from '@/utils/shared/quickChat';
import CopyLinkButton from '@/frontend/components/shared/CopyLinkButton';
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
import {
  conversationCardSplitBackground,
  conversationOriginColor,
  conversationStatusColor,
} from './conversationCardPalette';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { chatService } from '@/frontend/services/chat';
import StickySearchBar from '@/frontend/components/shared/StickySearchBar';
import { useAutoFocusSearch } from '@/frontend/hooks/useAutoFocusSearch';

interface ChatHistoryProps {
  conversations: ConversationListItem[]; // Use ConversationListItem[]
  /** Total persisted rows matching the unfiltered sidebar, including unloaded pages. */
  totalConversations?: number;
  hasMoreConversations?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => Promise<void>;
  /** Explicitly materialize all pages for complete bulk-action semantics. */
  onLoadAll?: () => Promise<ConversationListItem[]>;
  currentConversationId: string | null;
  /** One-shot, URL-originated request to reveal a conversation (issue #397):
   *  expands the group/chain that contains it and scrolls its row into view
   *  exactly once. Ordinary selection changes intentionally do NOT scroll. */
  revealRequest?: ChatRevealRequest | null;
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
  /** Whether the sidebar is currently collapsed — flips the toggle button's
   *  tooltip/aria-label between "collapse" and "expand". Defaults to false so
   *  existing call sites that don't pass it keep the previous "hide" wording. */
  collapsed?: boolean;
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

// Bounded retry budget for a URL reveal (issue #397). A row can be one frame
// late (Collapse mount, list re-render); it must never retry forever when a
// filter or a closed mobile drawer keeps it unmounted.
const MAX_REVEAL_ATTEMPTS = 10;

const STATUS_OPTIONS: StatusFilter[] = ['all', 'running', 'awaiting_tool_approval', 'paused_debug', 'completed', 'error'];
const DATE_OPTIONS: DateFilter[] = ['all', 'today', '7d', '30d'];
const GROUP_OPTIONS: GroupMode[] = ['none', 'date', 'flow', 'origin', 'wave', 'chain'];

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

const ChatHistory: React.FC<ChatHistoryProps> = ({
  conversations,
  totalConversations = conversations.length,
  hasMoreConversations = false,
  isLoadingMore = false,
  onLoadMore,
  onLoadAll,
  currentConversationId,
  revealRequest = null,
  onSelectConversation,
  onDeleteConversation,
  onBulkDelete,
  onStopConversation,
  onNewConversation,
  onQuickChat,
  onCollapse,
  collapsed = false,
  flowNames = {},
}) => {
  const { t, tp, formatDate: formatLocalizedDate } = useI18n();
  const muiTheme = useMuiTheme();
  const { visualStyle } = useAppTheme();
  const modern = visualStyle === 'modern';
  // Search text is intentionally ephemeral (not persisted): a stale filter
  // silently hiding conversations after a reload would be surprising.
  const [search, setSearch] = React.useState('');
  const searchInputRef = useAutoFocusSearch();
  // Confirmation dialog state for bulk delete (Delete All / Delete Visible).
  const [bulkDeleteDialog, setBulkDeleteDialog] = React.useState<{
    open: boolean; ids: string[]; label: string;
  }>({ open: false, ids: [], label: '' });
  const [bulkResolving, setBulkResolving] = React.useState(false);
  // Search dimension (issue #182): 'title' filters client-side over titles+flow
  // (Phase 1); 'content' resolves matches server-side against message bodies
  // (which aren't all resident on the client). Persisted so the choice sticks.
  const [searchDimension, setSearchDimension] = useUiPreference<'title' | 'content'>(
    PREF.searchDim,
    'title',
  );
  // Search must span unloaded pages. While a query is active, this complete
  // server-backed result set temporarily replaces the incrementally-loaded
  // browse pages. null means the debounced request is still in flight.
  const [searchResults, setSearchResults] = React.useState<ConversationListItem[] | null>(null);
  const [groupMode, setGroupMode] = useUiPreference<GroupMode>(PREF.group, 'none');
  const [statusFilter, setStatusFilter] = useUiPreference<StatusFilter>(PREF.status, 'all');
  const [flowFilter, setFlowFilter] = useUiPreference<string>(PREF.flow, 'all');
  const [dateFilter, setDateFilter] = useUiPreference<DateFilter>(PREF.date, 'all');
  const [collapsedGroups, setCollapsedGroups] = useUiPreference<Record<string, boolean>>(
    PREF.collapsed,
    {},
  );
  const sourceConversations = search.trim().length > 0
    ? (searchResults ?? [])
    : conversations;

  // Wave grouping (issue #181): the wave graph is only needed while grouping by
  // wave, so fetch it lazily and refresh it when wave membership changes.
  // Status/title updates do not need another wave request. Failures are tolerated
  // silently — grouping just falls back to the Ad-hoc / Archived buckets.
  const [waves, setWaves] = React.useState<WavesResponse | null>(null);
  const waveMembershipKey = useMemo(
    () => sourceConversations
      .map((conversation) => `${conversation.id}:${conversation.plannedExecutionId ?? ''}`)
      .join('\u0000'),
    [sourceConversations],
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

  // Search spans the complete paged collection rather than only loaded browse
  // rows. Content matching remains server-side; title mode loads lightweight
  // summaries and keeps the existing title/flow/origin matching semantics.
  React.useEffect(() => {
    const q = search.trim();
    if (q.length === 0) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    setSearchResults(null);
    const timer = setTimeout(() => {
      chatService.listAllConversationPages({
        ...(searchDimension === 'content' ? { search: q } : {}),
        dimension: searchDimension,
      })
        .then((data) => {
          if (cancelled) return;
          setSearchResults(data);
        })
        .catch(() => { if (!cancelled) setSearchResults([]); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, searchDimension]);

  // Format date for display
  const formatTimestamp = (timestamp: number) =>
    formatLocalizedDate(timestamp, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

  const statusLabel = (status: StatusFilter) => ({
    all: t('chat.status.any'),
    running: t('chat.status.processing'),
    awaiting_tool_approval: t('chat.status.awaiting'),
    paused_debug: t('chat.status.paused'),
    completed: t('chat.status.completed'),
    capped: t('chat.status.capped'),
    error: t('chat.status.error'),
  })[status];

  const dateLabel = (filter: DateFilter) => ({
    all: t('chat.date.any'),
    today: t('chat.date.day'),
    '7d': t('chat.date.week'),
    '30d': t('chat.date.month'),
  })[filter];

  const groupLabel = (mode: GroupMode) => ({
    none: t('chat.group.none'),
    date: t('chat.group.date'),
    flow: t('chat.group.agent'),
    origin: t('chat.group.origin'),
    wave: t('chat.group.wave'),
    chain: t('chat.group.chain'),
  })[mode];

  const originLabel = React.useCallback(
    (key: ConversationOriginKey) => t(`chat.origin.${key}` as any),
    [t],
  );

  const originDescription = React.useCallback(
    (key: ConversationOriginKey) => t(`chat.origin.description.${key}` as any),
    [t],
  );

  // Get status description for tooltip
  const getStatusDescription = (status?: ConversationListItem['status']) => {
    switch (status) {
      case 'running': return t('chat.status.processing');
      case 'awaiting_tool_approval': return t('chat.status.waitingTooltip');
      case 'paused_debug': return t('chat.status.pausedTooltip');
      case 'completed': return t('chat.status.completed');
      case 'capped': return t('chat.status.capped');
      case 'error': return t('chat.status.error');
      default: return '';
    }
  };

  // Resolve a conversation's flow into a stable grouping key + display label.
  // Quick-chat snapshots share one bucket ("Quick Chat"); a flowId not present
  // in the loaded flows map (e.g. a since-deleted flow) is shown as "Unknown
  // flow" rather than dropped, so the conversation stays discoverable.
  const flowMeta = React.useCallback(
    (flowId: string | null): { key: string; label: string } => {
      if (!flowId) return { key: 'flow:__none__', label: t('chat.history.noAgent') };
      if (isQuickChatFlowId(flowId)) return { key: 'flow:__quickchat__', label: t('chat.quick.title') };
      return { key: `flow:${flowId}`, label: flowNames[flowId] ?? t('chat.history.unknownAgent') };
    },
    [flowNames, t],
  );

  // Distinct flow options for the flow filter, derived from the conversations
  // actually present (deduped by grouping key), sorted A–Z by label.
  const flowOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of sourceConversations) {
      const meta = flowMeta(c.flowId);
      if (!map.has(meta.key)) map.set(meta.key, meta.label);
    }
    return Array.from(map.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sourceConversations, flowMeta]);

  // Apply search + filters, then sort most-recent-first. Memoized so SSE-driven
  // re-renders of the parent don't re-run the whole pipeline needlessly.
  const filterConversations = React.useCallback((source: ConversationListItem[]) => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const dateCutoff =
      dateFilter === 'today' ? now - DAY
      : dateFilter === '7d' ? now - 7 * DAY
      : dateFilter === '30d' ? now - 30 * DAY
      : 0;

    return source
      .filter((c) => {
        if (statusFilter !== 'all' && c.status !== statusFilter) return false;
        if (flowFilter !== 'all' && flowMeta(c.flowId).key !== flowFilter) return false;
        if (dateCutoff && c.updatedAt < dateCutoff) return false;
        if (q) {
          if (searchDimension === 'content') {
            // Content search is already resolved server-side.
          } else {
            const origin = getConversationOrigin(c);
            const haystack = `${c.title} ${flowMeta(c.flowId).label} ${originLabel(origin.key)}`.toLowerCase();
            if (!haystack.includes(q)) return false;
          }
        }
        return true;
      })
      .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
  }, [search, searchDimension, statusFilter, flowFilter, dateFilter, flowMeta, originLabel]);

  const filtered = useMemo(
    () => filterConversations(sourceConversations),
    [filterConversations, sourceConversations],
  );

  // Build the (optionally grouped) sections to render.
  const groups: CardGroup<ConversationListItem>[] = useMemo(() => {
    if (groupMode === 'none') {
      return [{ key: 'all', label: '', items: filtered }];
    }
    if (groupMode === 'wave') {
      // Bucket by wave; keep the Ad-hoc / Archived fallback buckets last.
      return orderWaveGroups(
        groupItems(filtered, (c) => waveBucket(c.plannedExecutionId, waveLookup)),
      ).map((group) => ({
        ...group,
        label: group.key === 'wave:__adhoc__'
          ? t('chat.group.adhoc')
          : group.key === 'wave:__archived__'
            ? t('chat.group.archived')
            : group.label,
      }));
    }
    return groupItems(filtered, (c) => {
       if (groupMode === 'date') {
         const bucket = recencyBucket(c.updatedAt);
         const labels: Record<string, string> = {
           'recency:unknown': t('flows.group.noDate'),
           'recency:today': t('flows.group.today'),
           'recency:week': t('flows.group.week'),
           'recency:month': t('flows.group.month'),
           'recency:older': t('flows.group.older'),
         };
         return { ...bucket, label: labels[bucket.key] ?? bucket.label };
       }
      if (groupMode === 'origin') {
        const origin = getConversationOrigin(c);
         return { key: `origin:${origin.key}`, label: originLabel(origin.key) };
      }
      return flowMeta(c.flowId);
    });
  }, [filtered, groupMode, flowMeta, waveLookup, originLabel, t]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // "By chain" grouping (issue #182): nest child conversations under the parent
  // that spawned them, using the persisted parentConversationId links. The
  // index is only built while that mode is active. When a parent is missing
  // from this page/filter the child falls back to its chain root, and if that
  // is missing too it renders at the top level flagged as detached, so a
  // subagent run is never mistaken for a real chain root (see buildChainIndex).
  const chainIndex = useMemo(
    () =>
      groupMode === 'chain'
        ? buildChainIndex(filtered)
        : { roots: [], childrenByParent: new Map(), detachedIds: new Set<string>() },
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

  // --- URL reveal (issue #397) ---------------------------------------------
  // Opening a chat through `/chat?conversation=<id>` must actually SHOW that
  // row: un-collapse the group / chain ancestors hiding it, then scroll it into
  // view exactly once per request. Everything is keyed to the parent's
  // monotonic `requestKey`, so ordinary clicks, streamed status updates and
  // unrelated rerenders never scroll the sidebar (and nothing ever calls
  // `.focus()`, which would steal focus from the chat composer).
  const listRef = React.useRef<HTMLUListElement | null>(null);
  const revealedKeyRef = React.useRef<number | null>(null);
  const pendingRevealKeyRef = React.useRef<number | null>(null);
  const revealAttemptsRef = React.useRef(0);
  const [revealAttempt, setRevealAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!revealRequest) return;
    const { id, requestKey } = revealRequest;
    if (revealedKeyRef.current === requestKey) return; // already revealed once
    // The reveal follows the selection: a mismatch means the request is stale,
    // or the parent's selection has not committed yet (this effect re-runs).
    if (id !== currentConversationId) return;
    if (typeof window === 'undefined') return;

    if (pendingRevealKeyRef.current !== requestKey) {
      pendingRevealKeyRef.current = requestKey;
      revealAttemptsRef.current = 0;
    }

    // Search/filters may legitimately exclude the row. Never silently clear the
    // user's persisted preferences -- stay pending (without burning the retry
    // budget) until the effective list contains the target again.
    if (!filtered.some((c) => c.id === id)) return;

    // 1. Grouped modes: explicitly OPEN the containing group (never toggle, so
    //    the effect is idempotent). The key comes from the same `groups` memo
    //    that renders the sections, so it cannot drift from what is rendered.
    const group = groupMode !== 'none' && groupMode !== 'chain'
      ? groups.find((g) => g.items.some((item) => item.id === id))
      : undefined;
    if (group && collapsedGroups[group.key]) {
      setCollapsedGroups((prev) => (prev[group.key] ? { ...prev, [group.key]: false } : prev));
      return; // re-runs once the group has committed open
    }

    // 2. Tree modes (chain, and the per-wave trees): expand every collapsed
    //    ancestor on the rendered path. `ConversationTree` unmounts collapsed
    //    children, so an ancestor left closed keeps the row out of the DOM.
    const tree = groupMode === 'chain'
      ? chainIndex
      : group
        ? waveChainByGroup.get(group.key)
        : undefined;
    if (tree) {
      const parentOf = new Map<string, string>();
      const childrenByParent = tree.childrenByParent as Map<string, ConversationListItem[]>;
      for (const [parentId, children] of childrenByParent) {
        for (const child of children) parentOf.set(child.id, parentId);
      }
      const collapsedAncestors: string[] = [];
      const seen = new Set<string>([id]);
      let cursor = parentOf.get(id);
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        if (expandedChains[cursor] === false) collapsedAncestors.push(cursor);
        cursor = parentOf.get(cursor);
      }
      if (collapsedAncestors.length > 0) {
        setExpandedChains((prev) => {
          const next = { ...prev };
          for (const ancestor of collapsedAncestors) next[ancestor] = true;
          return next;
        });
        return; // re-runs once the ancestors have committed open
      }
    }

    // 3. Scroll the mounted row once. `block: 'nearest'` keeps an already
    //    visible row exactly where it is instead of re-centering the list.
    const frame = window.requestAnimationFrame(() => {
      const row = listRef.current
        ? Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-conversation-id]'))
            .find((element) => element.getAttribute('data-conversation-id') === id)
        : undefined;
      if (row) {
        revealedKeyRef.current = requestKey;
        row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        return;
      }
      revealAttemptsRef.current += 1;
      if (revealAttemptsRef.current >= MAX_REVEAL_ATTEMPTS) {
        // Bounded: e.g. a closed mobile drawer never mounts the row. Consume
        // the request rather than spinning frames forever.
        revealedKeyRef.current = requestKey;
        return;
      }
      setRevealAttempt((attempt) => attempt + 1);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    revealRequest,
    currentConversationId,
    filtered,
    groups,
    groupMode,
    collapsedGroups,
    setCollapsedGroups,
    chainIndex,
    waveChainByGroup,
    expandedChains,
    revealAttempt,
  ]);

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (flowFilter !== 'all' ? 1 : 0) +
    (dateFilter !== 'all' ? 1 : 0);

  // `detached` = this row's parent chain could not be resolved in the current
  // view; the tree placement is a fallback, so the card says so explicitly.
  const renderConversation = (
    conversation: ConversationListItem,
    opts?: { detached?: boolean },
  ) => {
    const detached = opts?.detached === true;
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
    const localizedOriginLabel = originLabel(origin.key);
    const localizedOriginDescription = originDescription(origin.key);
    const OriginIcon = ORIGIN_ICONS[origin.key];
    const originColor = conversationOriginColor(origin.key, muiTheme);
    const statusColor = conversationStatusColor(conversation.status, muiTheme);
    const surfaceStrength = selected
      ? (muiTheme.palette.mode === 'dark' ? 0.38 : 0.3)
      : (muiTheme.palette.mode === 'dark' ? 0.3 : 0.23);

    return (
      <ListItem
        key={conversation.id}
        // Stable reveal target for URL deep links (issue #397). Looked up by
        // attribute comparison (not selector interpolation) so an arbitrary id
        // can never break or inject into the query.
        data-conversation-id={conversation.id}
        data-conversation-origin={origin.key}
        disablePadding
        secondaryAction={
          <Box
            className="conversation-card-actions"
            sx={modern ? {
              display: 'flex',
              zIndex: 2,
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
              <Tooltip title={t('chat.history.stop')}>
                <IconButton
                  edge="end"
                  size="small"
                  aria-label={t('chat.history.stop')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStopConversation!(conversation.id);
                  }}
                >
                  <StopCircleIcon color="error" fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <CopyLinkButton target={{ kind: 'conversation', id: conversation.id }} />
            <Tooltip title={t('chat.history.delete')}>
              <IconButton
                edge="end"
                size="small"
                aria-label={t('chat.history.delete')}
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
          bgcolor: alpha(muiTheme.palette.background.paper, muiTheme.palette.mode === 'dark' ? 0.72 : 0.82),
          backgroundImage: conversationCardSplitBackground(originColor, statusColor, surfaceStrength),
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
          '&::after': {
            content: '""',
            position: 'absolute',
            zIndex: 0,
            top: 0,
            bottom: 0,
            left: '90%',
            width: 1,
            bgcolor: alpha(statusColor, 0.5),
            pointerEvents: 'none',
          },
          '&:hover': {
            transform: 'translateY(-1px)',
            borderColor: alpha(originColor, 0.58),
            boxShadow: `0 10px 28px ${alpha(originColor, muiTheme.palette.mode === 'dark' ? 0.2 : 0.14)}`,
            '& .conversation-card-actions': { opacity: 1 },
          },
          '&:focus-within .conversation-card-actions': { opacity: 1 },
          '@media (hover: none)': { '& .conversation-card-actions': { opacity: 1 } },
          // The row button is deliberately raised above the decorative card
          // layers. Raise MUI's absolutely-positioned secondary-action wrapper
          // one step further so it remains the pointer target over that button.
          '& > .MuiListItemSecondaryAction-root': { zIndex: 2 },
        } : {
          opacity: selected ? 1 : 0.7,
          '& > .MuiListItemSecondaryAction-root': { zIndex: 2 },
        }}
      >
        <ListItemButton
          selected={selected}
          onClick={() => onSelectConversation(conversation.id)}
          aria-label={t('chat.history.openAria', {
            title: conversation.title,
            origin: localizedOriginLabel,
            status: getStatusDescription(conversation.status) || t('chat.history.unknown'),
          })}
          sx={{
            position: 'relative',
            zIndex: 1,
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
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
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
                    title={`${localizedOriginDescription}${origin.inferred ? ` (${t('chat.history.inferred')})` : ''}`}
                  >
                    <Chip
                      icon={<OriginIcon />}
                      label={localizedOriginLabel}
                      size="small"
                      variant="outlined"
                      sx={{
                        height: modern ? 22 : 20,
                        color: modern ? originColor : undefined,
                        borderColor: modern ? alpha(originColor, 0.72) : undefined,
                        bgcolor: modern ? alpha(originColor, 0.13) : undefined,
                        '& .MuiChip-icon': { fontSize: 14, color: modern ? originColor : undefined },
                        '& .MuiChip-label': {
                          px: 0.75,
                          fontSize: '0.68rem',
                          fontWeight: modern ? 700 : 500,
                        },
                      }}
                    />
                  </Tooltip>
                )}
                {/* Parent chain unresolved in this view (paginated off the page,
                    hidden by a filter, deleted, or an ephemeral parent that was
                    never persisted). Without this the row is indistinguishable
                    from a genuine top-level automation/user chat. */}
                {detached && (
                  <Tooltip title={t('chat.chain.detachedHelp')}>
                    <Chip
                      icon={<LinkOffRoundedIcon />}
                      label={t('chat.chain.detached')}
                      size="small"
                      variant="outlined"
                      sx={{
                        height: modern ? 22 : 20,
                        color: muiTheme.palette.text.secondary,
                        borderColor: alpha(muiTheme.palette.text.secondary, 0.45),
                        borderStyle: 'dashed',
                        '& .MuiChip-icon': { fontSize: 14, color: muiTheme.palette.text.secondary },
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
                  <Tooltip title={isQuickChat ? t('chat.history.quickNoAgent') : t('chat.history.agentNamed', { agent: meta.label })}>
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
                    {formatTimestamp(conversation.updatedAt)}
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

  const totalCount = search.trim() ? sourceConversations.length : totalConversations;
  const matchCount = filtered.length;

  const openDeleteAllDialog = async () => {
    setBulkResolving(true);
    try {
      const all = onLoadAll ? await onLoadAll() : conversations;
      setBulkDeleteDialog({
        open: true,
        ids: all.map(c => c.id),
        label: tp('chat.history.deleteAllQuestion', all.length),
      });
    } finally {
      setBulkResolving(false);
    }
  };

  const openDeleteVisibleDialog = async () => {
    setBulkResolving(true);
    try {
      const completeSource = search.trim()
        ? sourceConversations
        : (onLoadAll ? await onLoadAll() : conversations);
      const visible = filterConversations(completeSource);
      setBulkDeleteDialog({
        open: true,
        ids: visible.map(c => c.id),
        label: tp('chat.history.deleteVisibleQuestion', visible.length),
      });
    } finally {
      setBulkResolving(false);
    }
  };

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
          <Tooltip title={collapsed ? t('chat.history.expand') : t('chat.history.collapse')}>
            <IconButton size="small" onClick={onCollapse} aria-label={collapsed ? t('chat.history.expand') : t('chat.history.collapse')}>
              <ViewSidebarIcon />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" sx={{ display: 'block', color: 'primary.light', fontWeight: 760, letterSpacing: '.1em' }}>
            {t('chat.history.agentRuns')}
          </Typography>
          <Typography variant="h6" noWrap>{t('chat.history.title')}</Typography>
        </Box>
        {totalConversations > 0 && (
          <Tooltip title={t('chat.history.deleteAll')}>
            <span>{/* span wrapper needed for Tooltip on (potentially) disabled buttons */}
              <IconButton
                size="small"
                color="error"
                aria-label={t('chat.history.deleteAll')}
                disabled={bulkResolving}
                onClick={() => void openDeleteAllDialog()}
              >
                <DeleteForeverIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {filtered.length > 0 && (search.trim().length > 0 || activeFilterCount > 0) && (
          <Tooltip title={t('chat.history.deleteVisible')}>
            <span>
              <IconButton
                size="small"
                color="error"
                aria-label={t('chat.history.deleteVisible')}
                disabled={bulkResolving}
                onClick={() => void openDeleteVisibleDialog()}
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {onQuickChat && (
          <Tooltip title={t('chat.history.quickHelp')}>
            <Button
              variant="outlined"
              color="primary"
              startIcon={<BoltIcon />}
              onClick={onQuickChat}
              size="small"
            >
              {t('chat.history.quick')}
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
          {t('chat.history.new')}
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
        <StickySearchBar mode="container">
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              size="small"
              sx={{ flex: 1 }}
              inputRef={searchInputRef}
              placeholder={searchDimension === 'content' ? t('chat.history.searchContent') : t('chat.history.searchTitle')}
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
                    <IconButton size="small" aria-label={t('chat.history.clearSearch')} onClick={() => setSearch('')}>
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
                aria-label={t('chat.history.searchDimension')}
              >
                <MenuItem value="title">{t('chat.history.searchTitleOption')}</MenuItem>
                <MenuItem value="content">{t('chat.history.searchContentOption')}</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </StickySearchBar>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={groupMode}
              onChange={(e) => setGroupMode(e.target.value as GroupMode)}
              aria-label={t('chat.history.groupAria')}
            >
              {GROUP_OPTIONS.map((option) => (
                <MenuItem key={option} value={option}>{groupLabel(option)}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label={t('chat.history.filterStatus')}
            >
              {STATUS_OPTIONS.map((option) => (
                <MenuItem key={option} value={option}>{statusLabel(option)}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={flowOptions.some((o) => o.key === flowFilter) ? flowFilter : 'all'}
              onChange={(e) => setFlowFilter(e.target.value)}
              aria-label={t('chat.history.filterAgent')}
            >
              <MenuItem value="all">{t('chat.history.anyAgent')}</MenuItem>
              {flowOptions.map((o) => (
                <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 128, flex: '1 1 128px' }}>
            <Select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value as DateFilter)}
              aria-label={t('chat.history.filterDate')}
            >
              {DATE_OPTIONS.map((option) => (
                <MenuItem key={option} value={option}>{dateLabel(option)}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        {(search || activeFilterCount > 0) && (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">
              {t('chat.history.matchCount', { shown: matchCount, total: totalCount })}
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
              {t('chat.history.clearFilters')}
            </Button>
          </Box>
        )}
      </Box>

      <Divider />

      <List
        ref={listRef}
        aria-label={t('chat.history.title')}
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
              primary={t('chat.history.empty')}
              secondary={t('chat.history.emptyHelp')}
              primaryTypographyProps={{ align: 'center' }}
              secondaryTypographyProps={{ align: 'center' }}
            />
          </ListItem>
        ) : matchCount === 0 ? (
          <ListItem>
            <ListItemText
              primary={t('chat.history.noMatch')}
              secondary={t('chat.history.noMatchHelp')}
              primaryTypographyProps={{ align: 'center' }}
              secondaryTypographyProps={{ align: 'center' }}
            />
          </ListItem>
        ) : groupMode === 'chain' ? (
          <ConversationTree
            nodes={chainIndex.roots}
            childrenByParent={chainIndex.childrenByParent}
            renderItem={(c) => renderConversation(c, { detached: chainIndex.detachedIds.has(c.id) })}
            expanded={expandedChains}
            onToggle={toggleChain}
          />
        ) : groupMode === 'none' ? (
          // NB: wrap the call — Array.map would pass the index as `opts`.
          filtered.map((c) => renderConversation(c))
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
                      renderItem={(c) => renderConversation(c, { detached: waveChain.detachedIds.has(c.id) })}
                      expanded={expandedChains}
                      onToggle={toggleChain}
                    />
                  ) : (
                    group.items.map((c) => renderConversation(c))
                  )}
                </Collapse>
              </Box>
            );
          })
        )}
        {!search.trim() && hasMoreConversations && onLoadMore && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={isLoadingMore}
              startIcon={isLoadingMore ? <CircularProgress size={14} /> : undefined}
              onClick={() => void onLoadMore()}
            >
              {t('chat.history.loadMore')}
            </Button>
          </Box>
        )}
      </List>

      <Dialog
        open={bulkDeleteDialog.open}
        onClose={() => setBulkDeleteDialog(prev => ({ ...prev, open: false }))}
        aria-labelledby="bulk-delete-dialog-title"
      >
        <DialogTitle id="bulk-delete-dialog-title">{t('chat.history.confirmDelete')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {bulkDeleteDialog.label} {t('chat.history.cannotUndo')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkDeleteDialog(prev => ({ ...prev, open: false }))}>
            {t('common.cancel')}
          </Button>
          <Button
            color="error"
            onClick={async () => {
              setBulkDeleteDialog(prev => ({ ...prev, open: false }));
              await onBulkDelete(bulkDeleteDialog.ids);
            }}
            autoFocus
          >
            {t('chat.history.deleteAction')}
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
