import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * GET /v1/chat/conversation-chains — read-only chain projection (issue #405).
 *
 * The experimental "chain chat" page needs, for every ACTIVE conversation, its
 * place in the parent/child chain plus one short preview of its latest
 * displayable message. Doing that from the browser would mean one
 * full-conversation GET per node (N+1 requests, each carrying the complete
 * message history). This route is the minimal server-side projection instead:
 *
 *  - durable `ConversationSummary` records supply topology and metadata,
 *    exactly like the conversation list route, with live state overlaid;
 *  - the active-status allowlist lives in one shared module;
 *  - inactive ANCESTORS of an active node are included (inactive) so the graph
 *    shows a real chain instead of a bag of orphans;
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
  status?: ConversationChainNodeStatus;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  parentConversationId: string | null;
  rootConversationId: string | null;
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
  let status = (live?.status ?? summary.status) as ConversationChainNodeStatus | undefined;
  if (status === 'running' && executionEventBus.currentSeq(summary.id) === 0) {
    status = 'error';
  }
  return {
    id: summary.id,
    title: live?.title ?? summary.title,
    ...(status ? { status } : {}),
    active: isActiveConversationStatus(status),
    createdAt: summary.createdAt,
    updatedAt: live?.updatedAt ?? summary.updatedAt,
    parentConversationId: live?.parentConversationId ?? summary.parentConversationId ?? null,
    rootConversationId: live?.rootConversationId ?? summary.rootConversationId ?? null,
  };
}

/**
 * Walk up the parent links, collecting ancestors that exist in this set. Cycle-
 * and depth-guarded: a corrupt chain contributes what it can and stops.
 */
function collectAncestors(
  start: ResolvedConversation,
  byId: Map<string, ResolvedConversation>,
  into: Set<string>
): void {
  let current = start;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parentId = current.parentConversationId;
    if (!parentId || parentId === current.id) return;
    const parent = byId.get(parentId);
    if (!parent) return;
    if (into.has(parent.id)) return; // already collected (or a cycle)
    into.add(parent.id);
    current = parent;
  }
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
  id: string
): Promise<{ lastMessage: ConversationChainNode['lastMessage']; previewUnavailable?: boolean }> {
  const live = FlowExecutor.conversationStates.get(id);
  if (live && Array.isArray(live.messages)) {
    return { lastMessage: extractLatestDisplayableMessage(live.messages, CHAIN_MESSAGE_PREVIEW_MAX_CHARS) };
  }

  if (!CONVERSATION_ID_PATTERN.test(id)) return { lastMessage: null, previewUnavailable: true };

  const filePath = path.join(conversationsDir(), `${id}.json`);
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_SNAPSHOT_SCAN_BYTES) {
      // Never spend an unbounded parse on a preview; the page shows a neutral
      // "preview unavailable" chip instead.
      return { lastMessage: null, previewUnavailable: true };
    }
    const state = JSON.parse(await fs.readFile(filePath, 'utf8')) as SharedState;
    return { lastMessage: extractLatestDisplayableMessage(state?.messages, CHAIN_MESSAGE_PREVIEW_MAX_CHARS) };
  } catch (error) {
    // Never log message text or payloads — just the id and the failure.
    log.warn('Could not resolve a chain message preview', { conversationId: id, error });
    return { lastMessage: null, previewUnavailable: true };
  }
}

async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

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
    const summaries = await listConversationSummaries();
    const resolved = summaries.map(resolveConversation);
    const byId = new Map(resolved.map((item) => [item.id, item]));

    // 1. Active nodes + their ancestors, so each chain renders as a real tree.
    const included = new Set<string>();
    for (const item of resolved) {
      if (!item.active) continue;
      included.add(item.id);
      collectAncestors(item, byId, included);
    }

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
      const ranked = [...members].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      );
      const kept = ranked.slice(0, MAX_NODES_PER_CHAIN);
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
        if (previewTargets.length >= MAX_PREVIEW_READS) break;
        previewTargets.push(node);
      }
    }

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= previewTargets.length) return;
        const node = previewTargets[index];
        const preview = await resolvePreview(node.id);
        node.lastMessage = preview.lastMessage;
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
