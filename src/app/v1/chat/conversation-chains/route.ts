import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * GET /v1/chat/conversation-chains — read-only chain projection (issue #405).
 *
 * The experimental "chain chat" page needs recent persisted conversations,
 * grouped by their parent/child chain, plus one short preview of each
 * conversation's latest user/assistant/tool activity. Doing that from the browser would
 * mean one full-conversation GET per node (N+1 requests, each carrying the complete
 * message history). This route is the minimal server-side projection instead:
 *
 *  - durable `ConversationSummary` records supply topology and metadata,
 *    exactly like the conversation list route, with live state overlaid;
 *  - active state remains explicit metadata, but completed/error chains stay
 *    visible instead of making the page empty whenever no run is in flight;
 *  - only ONE bounded, plain-text message preview per node ever leaves the
 *    server — never a history, tool payload, model context or provider error.
 *
 * GET-only, behind the same lock + localhost gates as every other conversation
 * route. Everything is capped: chains per response, nodes per chain, ancestor
 * walk depth, snapshot bytes read, and preview characters.
 */
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { listConversationSummaries } from '@/backend/execution/flow/conversationSummaryStore';
import type { ConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';
import type { SharedState } from '@/backend/execution/flow/types';
import {
  ACTIVE_CONVERSATION_STATUSES,
  isActiveConversationStatus,
} from '@/utils/shared/conversationActivity';
import { extractLatestDisplayableMessage } from '@/utils/shared/conversationPreview';
import {
  CHAIN_MESSAGE_PREVIEW_MAX_CHARS,
  type ConversationChainGraph,
  type ConversationChainNode,
  type ConversationChainNodeStatus,
  type ConversationChainsResponse,
} from '@/shared/types/conversationChain';

const log = createLogger('app/v1/chat/conversation-chains/route');

/** Same safe-id shape the conversation DELETE handler enforces. */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Chains returned when the caller does not ask for a specific one. */
const DEFAULT_CHAIN_LIMIT = 8;
const MAX_CHAIN_LIMIT = 25;
/** Nodes rendered per chain — keeps the graph readable AND the reads bounded. */
const MAX_NODES_PER_CHAIN = 60;
/** Total previews resolved per request (a preview may cost one snapshot read). */
const MAX_PREVIEW_READS = 120;
/** Defensive bound on the parent walk; persisted links should never be deep. */
const MAX_ANCESTOR_DEPTH = 64;
/** Snapshots larger than this are not parsed just to show a preview. */
const MAX_SNAPSHOT_SCAN_BYTES = 8 * 1024 * 1024;
const PREVIEW_READ_CONCURRENCY = 8;

interface ResolvedConversation {
  id: string;
  title: string;
  flowId: string | null;
  flowName?: string;
  status?: ConversationChainNodeStatus;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  parentConversationId: string | null;
  rootConversationId: string | null;
}

function projectedFlowName(
  flowId: string | null | undefined,
  snapshotName: unknown,
  statisticsName: unknown,
): string | undefined {
  const candidate = [snapshotName, statisticsName]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (candidate) return candidate.trim().slice(0, 160);
  return flowId?.startsWith('quickchat-') ? 'Quick Chat' : undefined;
}

function conversationsDir(): string {
  return path.join(getWorkspaceDataDir(), 'db', 'conversations');
}

/**
 * Durable summary + live overlay, identical in spirit to the conversation list
 * route: live values win, and a persisted `running` record with no live event
 * channel is projected as `error` (it was interrupted by a restart).
 */
function resolveConversation(summary: ConversationSummary): ResolvedConversation {
  const live = FlowExecutor.conversationStates.get(summary.id);
  const flowId = live?.flowId ?? summary.flowId ?? null;
  const flowName = projectedFlowName(
    flowId,
    live?.flowSnapshot?.name,
    live?.statisticsFlowName,
  );
  let status = (live?.status ?? summary.status) as ConversationChainNodeStatus | undefined;
  if (!live && status === 'running' && executionEventBus.currentSeq(summary.id) === 0) {
    status = 'error';
  }
  return {
    id: summary.id,
    title: live?.title ?? summary.title,
    flowId,
    ...(flowName ? { flowName } : {}),
    ...(status ? { status } : {}),
    active: isActiveConversationStatus(status),
    createdAt: summary.createdAt,
    updatedAt: live?.updatedAt ?? summary.updatedAt,
    parentConversationId: live?.parentConversationId ?? summary.parentConversationId ?? null,
    rootConversationId: live?.rootConversationId ?? summary.rootConversationId ?? null,
  };
}

/**
 * Topmost reachable ancestor id, falling back to a loaded `rootConversationId`
 * when a direct parent is missing. Cycle- and depth-guarded; worst case the
 * conversation is its own chain.
 */
function resolveChainRootId(
  start: ResolvedConversation,
  byId: Map<string, ResolvedConversation>
): string {
  const seen = new Set<string>([start.id]);
  let current = start;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parentId = current.parentConversationId;
    const parent = parentId && parentId !== current.id ? byId.get(parentId) : undefined;
    if (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      current = parent;
      continue;
    }
    const rootId = current.rootConversationId;
    const root = rootId && rootId !== current.id ? byId.get(rootId) : undefined;
    if (root && !seen.has(root.id) && !root.parentConversationId) {
      seen.add(root.id);
      current = root;
      continue;
    }
    return current.id;
  }
  return current.id;
}

/** Resolve one node's bounded preview, preferring live state over a disk read. */
async function resolvePreview(
  conversation: Pick<ResolvedConversation, 'id' | 'flowId' | 'flowName'>,
): Promise<{
  lastMessage: ConversationChainNode['lastMessage'];
  flowName?: string;
  previewUnavailable?: boolean;
}> {
  const { id } = conversation;
  const live = FlowExecutor.conversationStates.get(id);
  if (live && Array.isArray(live.messages)) {
    const flowName = projectedFlowName(
      live.flowId ?? conversation.flowId,
      live.flowSnapshot?.name,
      live.statisticsFlowName,
    ) ?? conversation.flowName;
    return {
      lastMessage: extractLatestDisplayableMessage(live.messages, CHAIN_MESSAGE_PREVIEW_MAX_CHARS),
      ...(flowName ? { flowName } : {}),
    };
  }

  if (!CONVERSATION_ID_PATTERN.test(id)) {
    return {
      lastMessage: null,
      ...(conversation.flowName ? { flowName: conversation.flowName } : {}),
      previewUnavailable: true,
    };
  }

  const filePath = path.join(conversationsDir(), `${id}.json`);
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_SNAPSHOT_SCAN_BYTES) {
      // Never spend an unbounded parse on a preview; the page shows a neutral
      // "preview unavailable" chip instead.
      return {
        lastMessage: null,
        ...(conversation.flowName ? { flowName: conversation.flowName } : {}),
        previewUnavailable: true,
      };
    }
    const state = JSON.parse(await fs.readFile(filePath, 'utf8')) as SharedState;
    const flowName = projectedFlowName(
      state?.flowId ?? conversation.flowId,
      state?.flowSnapshot?.name,
      state?.statisticsFlowName,
    ) ?? conversation.flowName;
    return {
      lastMessage: extractLatestDisplayableMessage(state?.messages, CHAIN_MESSAGE_PREVIEW_MAX_CHARS),
      ...(flowName ? { flowName } : {}),
    };
  } catch (error) {
    // Never log message text or payloads — just the id and the failure.
    log.warn('Could not resolve a chain message preview', { conversationId: id, error });
    return {
      lastMessage: null,
      ...(conversation.flowName ? { flowName: conversation.flowName } : {}),
      previewUnavailable: true,
    };
  }
}

/**
 * Keep a capped chain structurally useful: the true root is always present and
 * every selected descendant brings its loaded ancestor path with it. Ranking
 * still favours recently updated work, but never creates a forest merely
 * because an older parent fell outside the cap.
 */
function selectTreeStableMembers(
  rootId: string,
  members: ResolvedConversation[],
  limit: number,
): ResolvedConversation[] {
  if (members.length <= limit) return [...members];

  const memberById = new Map(members.map((member) => [member.id, member]));
  const selected = new Map<string, ResolvedConversation>();
  const root = memberById.get(rootId);
  if (root) selected.set(root.id, root);

  const ranked = [...members].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );

  for (const candidate of ranked) {
    if (selected.has(candidate.id)) continue;
    const path: ResolvedConversation[] = [];
    const seen = new Set<string>();
    let current: ResolvedConversation | undefined = candidate;
    while (current && !selected.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      const currentId: string = current.id;
      const parentId: string | null = current.parentConversationId;
      current = parentId && parentId !== currentId ? memberById.get(parentId) : undefined;
    }
    path.reverse();
    if (selected.size + path.length > limit) continue;
    for (const member of path) selected.set(member.id, member);
    if (selected.size >= limit) break;
  }

  return [...selected.values()];
}

async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const personaControlAllowed = assertLocalRequest(request) === null;

  const url = new URL(request.url);
  const rawRoot = (url.searchParams.get('root') ?? '').trim();
  const rawLimit = url.searchParams.get('limit');

  if (rawRoot && !CONVERSATION_ID_PATTERN.test(rawRoot)) {
    return NextResponse.json({ error: 'Invalid root conversation id' }, { status: 400 });
  }

  let chainLimit = DEFAULT_CHAIN_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CHAIN_LIMIT) {
      return NextResponse.json(
        { error: `limit must be an integer between 1 and ${MAX_CHAIN_LIMIT}` },
        { status: 400 }
      );
    }
    chainLimit = parsed;
  }

  try {
    const summaries = (await listConversationSummaries()).filter((summary) => (
      personaControlAllowed
      || (
        !summary.personaOwned
        && !isPersonaOwnedConversationState(FlowExecutor.conversationStates.get(summary.id))
      )
    ));
    const resolved = summaries.map(resolveConversation);
    const byId = new Map(resolved.map((item) => [item.id, item]));

    // 1. Keep recent history available even when no execution is currently in
    // flight. `active` is display metadata, not an inclusion gate.
    const included = new Set(resolved.map((item) => item.id));

    // 2. Group by chain root.
    const groups = new Map<string, ResolvedConversation[]>();
    for (const id of included) {
      const item = byId.get(id);
      if (!item) continue;
      const rootId = resolveChainRootId(item, byId);
      const group = groups.get(rootId) ?? [];
      group.push(item);
      groups.set(rootId, group);
    }

    // 3. Project each group into a capped, deterministically ordered chain.
    let chains: ConversationChainGraph[] = [...groups.entries()].map(([rootId, members]) => {
      const totalNodeCount = members.length;
      const kept = selectTreeStableMembers(rootId, members, MAX_NODES_PER_CHAIN);
      const ordered = [...kept].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      );
      const root = byId.get(rootId);
      return {
        rootId,
        title: root?.title ?? ordered[0]?.title ?? rootId,
        updatedAt: ordered.reduce((max, item) => Math.max(max, item.updatedAt), 0),
        activeNodeCount: ordered.filter((item) => item.active).length,
        totalNodeCount,
        truncated: totalNodeCount > kept.length,
        nodes: ordered.map((item): ConversationChainNode => ({
          id: item.id,
          title: item.title,
          ...(item.flowName ? { flowName: item.flowName } : {}),
          ...(item.status ? { status: item.status } : {}),
          active: item.active,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          parentConversationId: item.parentConversationId,
          rootConversationId: item.rootConversationId,
          lastMessage: null,
        })),
      };
    });

    // A root filter never confirms or denies existence: it simply narrows.
    if (rawRoot) chains = chains.filter((chain) => chain.rootId === rawRoot);

    chains.sort((a, b) => b.updatedAt - a.updatedAt || a.rootId.localeCompare(b.rootId));
    const totalChains = chains.length;
    const visibleChains = chains.slice(0, chainLimit);

    // 4. Resolve bounded previews for the returned nodes only.
    const previewTargets: ConversationChainNode[] = [];
    for (const chain of visibleChains) {
      for (const node of chain.nodes) {
        if (previewTargets.length < MAX_PREVIEW_READS) previewTargets.push(node);
        else node.previewUnavailable = true;
      }
    }

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= previewTargets.length) return;
        const node = previewTargets[index];
        const source = byId.get(node.id);
        if (!source) continue;
        const preview = await resolvePreview(source);
        node.lastMessage = preview.lastMessage;
        if (!node.flowName && preview.flowName) node.flowName = preview.flowName;
        if (preview.previewUnavailable) node.previewUnavailable = true;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PREVIEW_READ_CONCURRENCY, Math.max(1, previewTargets.length)) },
        () => worker()
      )
    );

    const body: ConversationChainsResponse = {
      chains: visibleChains,
      totalChains,
      truncated: totalChains > visibleChains.length,
      activeStatuses: [...ACTIVE_CONVERSATION_STATUSES],
      generatedAt: Date.now(),
    };

    log.debug('Projected conversation chains', {
      chains: visibleChains.length,
      totalChains,
      nodes: previewTargets.length,
    });
    return NextResponse.json(body);
  } catch (error) {
    log.error('Failed to build conversation chains', error);
    return NextResponse.json({ error: 'Failed to build conversation chains' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
