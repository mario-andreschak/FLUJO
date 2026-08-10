import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server'; // Import NextRequest
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { SharedState } from '@/backend/execution/flow/types';
import { Flow } from '@/shared/types/flow';
import {
  saveCollectionItem,
  assertSafeCollectionId,
  deleteCollectionItem,
  loadCollectionItem,
} from '@/utils/storage/backend';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { markConversationDeleted, unmarkConversationDeleted } from '@/backend/execution/flow/cancellation';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { deleteRunResources } from '@/backend/services/runResources';
import { quickChatFlowId } from '@/utils/shared/quickChat';
import { DEFAULT_CONVERSATION_TITLE } from '@/utils/shared/conversationTitle';
import { deleteConversationLog } from '@/backend/execution/flow/conversationLog';
import { reconcileInterruptedRecovery } from '@/backend/execution/flow/recoveryCheckpoint';
import type { StorageKey } from '@/shared/types/storage';
import {
  deleteConversationSummary,
  listConversationSummaries,
  persistConversationSummary,
  persistConversationSummaryStrict,
} from '@/backend/execution/flow/conversationSummaryStore';
import { flowService } from '@/backend/services/flow';
import {
  getPersona,
  getPersonaDeletionTombstone,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import {
  ConversationCursorError,
  paginateConversationSummaries,
} from '@/backend/execution/flow/conversationListPage';
// Use frontend type for response structure, maybe rename for clarity?
import { ConversationListItem as FrontendConversationListItem } from '@/frontend/components/Chat';

const log = createLogger('app/v1/chat/conversations/route');

// Define the structure for the list item returned by GET.
// Keep it as an alias so it stays exactly aligned with the frontend contract.
type ConversationListItem = FrontendConversationListItem;

// Parsed-summary cache for the list GET, keyed by workspace + file name. The sidebar now
// polls this endpoint every few seconds, and conversation files carry the FULL
// message history — re-reading and JSON.parsing every file on every poll is
// O(total bytes on disk). The summary only needs six small fields, so cache it
// per file and invalidate on mtime/size change (every write is an atomic
// replace, so a content change always moves the mtime). Conversation ids/file
// names are only unique within a workspace; a process-wide filename-only cache
// can otherwise return one workspace's title/status/flow metadata in another.
type CachedConversationListItem = ConversationListItem & { personaOwned?: true };
const listSummaryCache = new Map<string, {
  mtimeMs: number;
  size: number;
  item: CachedConversationListItem;
}>();

const listSummaryCachePrefix = () => workspaceCacheKey('conversation-list-summary');
const listSummaryCacheKey = (file: string) => workspaceCacheKey('conversation-list-summary', file);

// Content search (issue #182). Message bodies are not all resident on the
// client, so a `?search=<term>&dimension=content` request scans the on-disk
// conversation files server-side. Bounds keep the scan cheap and abuse-proof:
//  - reject over-long terms outright (they can't be a legitimate title/keyword)
//  - skip pathologically large conversation files (can't be scanned cheaply)
// Only id/metadata is ever returned — the matched message text never leaves
// the server.
const MAX_SEARCH_TERM_LEN = 256;
const MAX_CONTENT_SCAN_BYTES = 8 * 1024 * 1024; // 8 MiB per conversation file

const ORIGIN_SEARCH_TERMS: Record<string, string> = {
  chat: 'chat user interactive',
  api: 'api',
  schedule: 'automation schedule planned execution',
  trigger: 'trigger unattended',
  subflow: 'subagent subflow child',
  mcp: 'mcp run',
  internal: 'internal',
  meeting: 'meeting multi-flow',
  unknown: 'unknown origin',
};

/** Searchable sidebar metadata is resolved on the server so the browser only
 *  receives the requested result page. Flow names are included because the UI
 *  presents those names (rather than opaque flow ids) as the conversation's
 *  agent. */
function sidebarMetadataMatches(
  item: ConversationListItem,
  query: string,
  flowNames: ReadonlyMap<string, string>,
): boolean {
  if (!query) return true;
  const origin = item.source
    ?? (item.parentConversationId ? 'subflow' : item.plannedExecutionId ? 'schedule' : 'unknown');
  const flowName = item.flowId?.startsWith('quickchat-')
    ? 'Quick Chat'
    : item.flowId ? (flowNames.get(item.flowId) ?? '') : 'No agent';
  return [
    item.id,
    item.title,
    item.flowId ?? '',
    flowName,
    origin,
    ORIGIN_SEARCH_TERMS[origin] ?? '',
  ].join(' ').toLocaleLowerCase().includes(query);
}

function conversationOrigin(item: ConversationListItem): string {
  return item.source
    ?? (item.parentConversationId ? 'subflow' : item.plannedExecutionId ? 'schedule' : 'unknown');
}

/** Resolve a complete transitive descendant set from durable parent links.
 *  Cycle guarded so corrupt lineage cannot loop forever. */
function descendantIds(items: ConversationListItem[], ancestorId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const item of items) {
    const parentId = item.parentConversationId;
    if (!parentId || parentId === item.id) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(item.id);
    childrenByParent.set(parentId, children);
  }
  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(ancestorId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === ancestorId || descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return descendants;
}

/** Case-insensitive substring test against a conversation's message CONTENT.
 *  Handles plain-string content and the multimodal array/object shapes (by
 *  stringifying non-string content). Short-circuits on the first match and
 *  never returns the matched text. */
function messageContentMatches(state: SharedState, qLower: string): boolean {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (const m of messages) {
    const content: unknown = (m as any)?.content;
    if (typeof content === 'string') {
      if (content.toLowerCase().includes(qLower)) return true;
    } else if (content != null) {
      try {
        if (JSON.stringify(content).toLowerCase().includes(qLower)) return true;
      } catch {
        /* ignore unstringifiable content */
      }
    }
  }
  return false;
}

// Define the expected structure for the POST request body
interface CreateConversationPayload {
  id: string;
  title: string;
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUserMessageAt?: number | null;
  /** Quick-Chats (issue #61): a self-contained flow definition to seed onto the
   *  conversation state instead of referencing a stored flow. When present, the
   *  engine resolves the flow from this snapshot; `flowId` must be the
   *  snapshot's id (quickchat-<id>). */
  flowSnapshot?: Flow;
  /** Non-authoritative target intent for a fresh Persona chat. */
  personaTargetId?: string;
}


// --- GET Handler (Existing) ---
async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143). Middleware guards
  // this route centrally too; kept inline for the internal control-plane sinks.
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const personaControlAllowed = assertLocalRequest(request) === null;

  const startTime = Date.now();
  const requestId = `conv-list-${Date.now()}`;
  log.info('Handling GET request for conversation list', { requestId });

  // Content search (issue #182). `dimension=content` triggers a server-side
  // scan of message bodies; `dimension=title` (default) preserves the existing
  // cheap summary listing the client filters itself. The `search` value is only
  // ever used as a substring needle (never as a path), so it needs no path-
  // traversal guard — just a length bound to keep the scan cheap.
  const url = new URL(request.url);
  const rawSearch = (url.searchParams.get('search') ?? '').trim();
  const dimension = url.searchParams.get('dimension') ?? 'title';
  const presenceOnly = url.searchParams.get('presence') === '1';
  const paged = url.searchParams.get('paged') === '1';
  const rawLimit = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const requestedOrigin = (url.searchParams.get('origin') ?? '').trim();
  const descendantsOf = (url.searchParams.get('descendantsOf') ?? '').trim();
  const allowedOrigins = new Set(['chat', 'schedule', 'subflow', 'meeting']);
  if (requestedOrigin && !allowedOrigins.has(requestedOrigin)) {
    return NextResponse.json({ error: 'invalid origin filter' }, { status: 400 });
  }
  if (descendantsOf) {
    try {
      assertSafeCollectionId(descendantsOf);
    } catch {
      return NextResponse.json({ error: 'invalid ancestor conversation id' }, { status: 400 });
    }
  }
  if (rawSearch.length > MAX_SEARCH_TERM_LEN) {
    return NextResponse.json(
      { error: `search term too long (max ${MAX_SEARCH_TERM_LEN} chars)` },
      { status: 400 });
  }
  const contentSearch = dimension === 'content' && rawSearch.length > 0;
  const contentQuery = rawSearch.toLowerCase();
  let pageLimit = 50;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return NextResponse.json({ error: 'limit must be an integer between 1 and 200' }, { status: 400 });
    }
    pageLimit = parsed;
  }

  const conversationsDir = path.join(getWorkspaceDataDir(), 'db', 'conversations');
  log.debug('Conversations directory path', { requestId, path: conversationsDir });

  try {
    const files = await fs.readdir(conversationsDir);
    log.debug(`Found ${files.length} items in directory`, { requestId });

    const jsonFiles = files.filter(file => file.endsWith('.json'));
    log.debug(`Found ${jsonFiles.length} JSON files`, { requestId });

    // The dashboard only needs to know whether saved chats exist. Avoid reading
    // and projecting every conversation file for that lightweight status check.
    if (presenceOnly) {
      if (personaControlAllowed) return NextResponse.json({ count: jsonFiles.length });
      const summaries = await listConversationSummaries();
      const count = summaries.filter((summary) => (
        !summary.personaOwned
        && !isPersonaOwnedConversationState(FlowExecutor.conversationStates.get(summary.id))
      )).length;
      return NextResponse.json({ count });
    }

    // The paged sidebar reads tiny durable summary sidecars instead of parsing
    // the full message-bearing snapshots. Content search is the one exception:
    // it intentionally scans message bodies and therefore follows the legacy
    // snapshot path below before applying the same keyset pagination.
    if (paged && !contentSearch) {
      const summaries = await listConversationSummaries();
      const query = rawSearch.toLocaleLowerCase();
      const flowNames = query
        ? new Map((await flowService.loadFlows()).map((flow) => [flow.id, flow.name]))
        : new Map<string, string>();
      let visible = summaries
        .filter((summary) => personaControlAllowed || (
          !summary.personaOwned
          && !isPersonaOwnedConversationState(FlowExecutor.conversationStates.get(summary.id))
        ))
        .map((summary): ConversationListItem => {
          const live = FlowExecutor.conversationStates.get(summary.id);
          let status = live?.status ?? summary.status;
          if (status === 'running' && executionEventBus.currentSeq(summary.id) === 0) {
            status = 'error';
          }
          const { personaOwned: _personaOwned, ...safeSummary } = summary;
          return {
            ...safeSummary,
            title: live?.title ?? summary.title,
            flowId: live?.flowId ?? summary.flowId,
            status,
            updatedAt: live?.updatedAt ?? summary.updatedAt,
            lastUserMessageAt: live?.lastUserMessageAt ?? summary.lastUserMessageAt ?? null,
            source: live?.source ?? summary.source ?? null,
            plannedExecutionId: live?.plannedExecutionId ?? summary.plannedExecutionId ?? null,
            parentConversationId: live?.parentConversationId ?? summary.parentConversationId ?? null,
            rootConversationId: live?.rootConversationId ?? summary.rootConversationId ?? null,
            recovery: live?.recovery ?? summary.recovery,
            ...(live?.personaArchived || summary.personaArchived
              ? { personaArchived: true as const }
              : {}),
          };
        })
        .filter((summary) => sidebarMetadataMatches(summary, query, flowNames));
      if (requestedOrigin) {
        visible = visible.filter((summary) => conversationOrigin(summary) === requestedOrigin);
      }
      if (descendantsOf) {
        const ids = descendantIds(visible, descendantsOf);
        visible = visible.filter((summary) => ids.has(summary.id));
      }
      try {
        return NextResponse.json(paginateConversationSummaries(visible, pageLimit, cursor));
      } catch (error) {
        if (error instanceof ConversationCursorError) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    const conversationPromises = jsonFiles.map(async (file): Promise<ConversationListItem | null> => {
      const filePath = path.join(conversationsDir, file);
      const conversationIdFromFile = file.replace('.json', ''); // Extract ID from filename

      try {
        // Summary from disk, via the mtime/size cache (see listSummaryCache).
        const stats = await fs.stat(filePath);
        const summaryCacheKey = listSummaryCacheKey(file);
        const cached = listSummaryCache.get(summaryCacheKey);
        let base: CachedConversationListItem;
        // Content search always needs the parsed body, so it bypasses the
        // summary-only cache-hit fast path (it still repopulates the cache).
        let parsedState: SharedState | undefined;
        const cacheHit = !!cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size;
        if (cacheHit && !contentSearch) {
          base = cached!.item;
        } else {
          // Skip pathologically large files under content search — they can't be
          // scanned cheaply and would blow the per-request cost budget.
          if (contentSearch && stats.size > MAX_CONTENT_SCAN_BYTES) {
            return null;
          }
          const fileContent = contentSearch
            ? await fs.readFile(filePath, { encoding: 'utf-8', signal: request.signal })
            : await fs.readFile(filePath, 'utf-8');
          const state = JSON.parse(fileContent) as SharedState;
          parsedState = state;
          if (!personaControlAllowed && isPersonaOwnedConversationState(state)) return null;
          // On the first sidebar load after a process restart, convert a running
          // record owned by the prior process into a durable interrupted state.
          if (!isPersonaOwnedConversationState(state)) {
            await reconcileInterruptedRecovery(
              `conversations/${state.conversationId || conversationIdFromFile}` as StorageKey,
              state,
            );
          }

          // Ensure ID consistency if possible
          if (state.conversationId && state.conversationId !== conversationIdFromFile) {
            log.warn(`Mismatch between filename ID (${conversationIdFromFile}) and state ID (${state.conversationId})`, { requestId, filePath });
            // Decide which ID to trust - let's trust the state's ID if present
          }

          base = {
            id: state.conversationId || conversationIdFromFile, // Prefer state ID, fallback to filename
            title: state.title || 'Untitled Conversation',
            flowId: state.flowId || null,
            createdAt: state.createdAt || 0,
            updatedAt: state.updatedAt || 0,
            lastUserMessageAt: state.lastUserMessageAt ?? null,
            status: state.status,
            recovery: state.recovery,
            // Invocation origin is persisted by runFlow. UI-created, not-yet-run
            // conversations are seeded as `chat` by POST below.
            source: state.source ?? null,
            // Wave grouping (issue #181): expose the already-persisted planned-
            // execution id so the sidebar can bucket conversations by wave.
            // null for ad-hoc chat/API runs. Read-only pass-through; no schema
            // change. Included in the cached summary shape below.
            plannedExecutionId: state.plannedExecutionId ?? null,
            // Chains/hierarchy (issue #182): expose the persisted conversation-
            // level parent link + eagerly-computed chain root so the sidebar
            // can render Flow->Subflow->... trees when grouping "by chain".
            // Absent on legacy conversations => they render as roots.
            parentConversationId: state.parentConversationId ?? null,
            rootConversationId: state.rootConversationId ?? null,
            ...(isPersonaOwnedConversationState(state)
              ? { personaOwned: true as const }
              : {}),
            ...(state.personaArchived ? { personaArchived: true as const } : {}),
            ...((state.personaAttribution?.personaId ?? state.personaTargetId)
              ? { personaId: state.personaAttribution?.personaId ?? state.personaTargetId }
              : {}),
            ...(state.personaAttribution?.activityId
              ? { activityId: state.personaAttribution.activityId }
              : {}),
            ...(state.personaAttribution?.behaviorRevisionId
              ? { behaviorRevisionId: state.personaAttribution.behaviorRevisionId }
              : {}),
          };
          listSummaryCache.set(summaryCacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, item: base });
        }

        // Content search (issue #182): exclude conversations whose message
        // bodies don't contain the term. Only the id/metadata projection is
        // returned below — the matched text itself never leaves the server.
        if (contentSearch && (!parsedState || !messageContentMatches(parsedState, contentQuery))) {
          return null;
        }

        // Live override: while a run is in flight the in-memory state is ahead
        // of the snapshot on disk (which is only written at run boundaries) —
        // without this, the sidebar of a resumed run reads the PREVIOUS
        // terminal status until the next persist. Memory is never staler than
        // disk here: every disk write comes from this same object.
        const live = FlowExecutor.conversationStates.get(base.id);
        if (!personaControlAllowed && (
          base.personaOwned
          || isPersonaOwnedConversationState(live)
        )) {
          return null;
        }
        let status = live?.status ?? base.status;
        const title = live?.title ?? base.title;
        const updatedAt = live?.updatedAt ?? base.updatedAt;
        const lastUserMessageAt = live?.lastUserMessageAt ?? base.lastUserMessageAt ?? null;
        const source = live?.source ?? base.source ?? null;
        // Prefer the live in-memory wave id for a running scheduler run (#181).
        const plannedExecutionId = live?.plannedExecutionId ?? base.plannedExecutionId ?? null;

        // Reconcile a stale 'running' status. A conversation persists as
        // 'running' while a flow executes, but a process restart drops the
        // in-memory run (and its event channel) without flipping the stored
        // status. Such a run can never resume — re-attaching to it just hangs
        // the live view on "Working…". If the status says 'running' but this
        // process has no live event channel for it, the run is dead: report it
        // as 'error' so the sidebar is honest and the client doesn't
        // auto-reattach to a run that will never emit again.
        if (status === 'running' && executionEventBus.currentSeq(base.id) === 0) {
          log.warn(`Conversation ${base.id} is 'running' with no live run; reporting as interrupted ('error').`, { requestId });
          status = 'error';
        }

        const { personaOwned: _personaOwned, ...safeBase } = base;
        return {
          ...safeBase,
          title,
          updatedAt,
          lastUserMessageAt,
          status,
          source,
          plannedExecutionId,
          ...(live?.personaArchived || base.personaArchived
            ? { personaArchived: true as const }
            : {}),
        };
      } catch (parseError) {
        if (request.signal.aborted || (parseError as { name?: string })?.name === 'AbortError') {
          return null;
        }
        log.error(`Error reading or parsing conversation file: ${file}`, { requestId, filePath, error: parseError });
        // Under content search an unparseable file can't be said to match, so
        // drop it rather than surfacing an "Error Loading" placeholder (#182).
        if (contentSearch) return null;
        // Try getting file system time as a fallback for sorting?
        try {
           const stats = await fs.stat(filePath);
           return {
              id: conversationIdFromFile,
              title: `Error Loading (${conversationIdFromFile})`,
              flowId: null,
              createdAt: stats.birthtimeMs,
              updatedAt: stats.mtimeMs,
              status: 'error',
              plannedExecutionId: null,
              source: null,
           }
        } catch (statError) {
           log.error(`Could not get stats for errored file: ${file}`, { requestId, statError });
           return null; // Skip this file entirely if stats fail too
        }
      }
    });

    const results = await Promise.all(conversationPromises);
    // Drop cache entries for files that no longer exist (deleted conversations).
    const workspacePrefix = `${listSummaryCachePrefix()}\0`;
    const workspaceCacheEntries = Array.from(listSummaryCache.keys())
      .filter(key => key.startsWith(workspacePrefix));
    const present = new Set(jsonFiles.map(listSummaryCacheKey));
    for (const key of workspaceCacheEntries) {
      if (!present.has(key)) listSummaryCache.delete(key);
    }
    const validConversations = results.filter((conv): conv is ConversationListItem => conv !== null);
    log.debug(`Successfully processed ${validConversations.length} conversation files`, { requestId });

    // Sort by lastUserMessageAt descending (falls back to updatedAt for legacy conversations)
    validConversations.sort((a, b) =>
      (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt)
    );

    const duration = Date.now() - startTime;
    log.info(`Successfully retrieved conversation list`, { requestId, count: validConversations.length, duration: `${duration}ms` });

    if (paged) {
      const visibleConversations = requestedOrigin
        ? validConversations.filter((conversation) => conversationOrigin(conversation) === requestedOrigin)
        : validConversations;
      try {
        return NextResponse.json(paginateConversationSummaries(visibleConversations, pageLimit, cursor));
      } catch (error) {
        if (error instanceof ConversationCursorError) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }
    return NextResponse.json(validConversations);

  } catch (error: any) {
    const duration = Date.now() - startTime;
    log.error('Error listing conversations', {
      requestId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, code: (error as NodeJS.ErrnoException).code } : error,
      duration: `${duration}ms`
    });

    // Check if the error is because the directory doesn't exist
    if (error.code === 'ENOENT') {
      log.warn('Conversations directory does not exist, returning empty list.', { requestId, path: conversationsDir });
      if (presenceOnly) return NextResponse.json({ count: 0 });
      if (paged) return NextResponse.json({ items: [], total: 0, hasMore: false });
      return NextResponse.json([]); // Legacy unpaged contract
    }

    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}


// --- POST Handler (New) ---
async function POST_handler(req: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143).
  const notLocal = assertLocalRequest(req);
  if (notLocal) return notLocal;

  const startTime = Date.now();
  const requestId = `conv-create-${Date.now()}`;
  log.info('Handling POST request to create conversation', { requestId });

  let payload: CreateConversationPayload;
  try {
    payload = await req.json();
    log.debug('Received payload', { requestId, payload: JSON.stringify(payload) }); // Use JSON.stringify for verbose logging
  } catch (error) {
    log.warn('Invalid JSON in request body', { requestId, error });
    return NextResponse.json({ error: 'Invalid request body: Must be valid JSON' }, { status: 400 });
  }

  // Basic validation
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid request body: Must be an object' }, { status: 400 });
  }
  if (!payload.id || typeof payload.id !== 'string') {
    return NextResponse.json({ error: 'Invalid request body: Missing or invalid "id" (string)' }, { status: 400 });
  }
  // Path-traversal guard (issue #126): the id becomes a filesystem path, so an
  // id like "../encryption_key" would escape db/conversations/ and overwrite an
  // arbitrary .json file. Reject anything outside the safe id charset with 400.
  try {
    assertSafeCollectionId(payload.id);
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body: "id" must match ^[A-Za-z0-9_-]{1,64}$' },
      { status: 400 });
  }
  if (!payload.title || typeof payload.title !== 'string') {
    payload.title = DEFAULT_CONVERSATION_TITLE; // Default title if missing
    log.warn('Missing title in payload, using default', { requestId, conversationId: payload.id });
  }
  const hasPersonaTarget = payload.personaTargetId !== undefined;
  if (hasPersonaTarget) {
    const personaNotLocal = assertLocalRequest(req);
    if (personaNotLocal) return personaNotLocal;
    if (
      typeof payload.personaTargetId !== 'string'
      || !EnduringAgentIdSchema.safeParse(payload.personaTargetId).success
    ) {
      return NextResponse.json({ error: 'Invalid personaTargetId.' }, { status: 400 });
    }
    if (payload.flowId !== null || payload.flowSnapshot) {
      return NextResponse.json(
        { error: 'Persona-targeted conversations must not select or embed a Flow.' },
        { status: 400 },
      );
    }
  } else if (typeof payload.flowId !== 'string' || !payload.flowId) {
    return NextResponse.json({ error: 'Invalid request body: Missing or invalid "flowId" (must be a non-empty string)' }, { status: 400 });
  }
  if (typeof payload.createdAt !== 'number' || typeof payload.updatedAt !== 'number') {
     log.warn('Missing or invalid timestamps in payload, using current time', { requestId, conversationId: payload.id });
     const now = Date.now();
     payload.createdAt = payload.createdAt || now;
     payload.updatedAt = payload.updatedAt || now;
   }


  const conversationId = payload.id;
  return withConversationExecutionLock(conversationId, async () => {
    // This is the authoritative ownership check. It shares the same lease as
    // runFlow and Persona anonymization, so a stale legacy create can neither
    // overwrite an archive nor race a Persona draft into existence after its
    // target was deleted.
    const existingState = FlowExecutor.conversationStates.get(conversationId)
      ?? await loadCollectionItem<SharedState | undefined>(
        'conversations',
        conversationId,
        undefined,
      );
    if (isPersonaOwnedConversationState(existingState)) {
      const personaNotLocal = assertLocalRequest(req);
      if (personaNotLocal) return personaNotLocal;
      return NextResponse.json(
        { error: 'Persona-owned conversations cannot be overwritten by the legacy create route.' },
        { status: 409 },
      );
    }

    if (hasPersonaTarget) {
      const personaId = payload.personaTargetId!;
      if (await getPersonaDeletionTombstone(personaId)) {
        return NextResponse.json(
          { error: 'Persona is being deleted or has been deleted.' },
          { status: 409 },
        );
      }
      const persona = await getPersona(personaId);
      if (!persona) {
        return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
      }
      if (
        persona.provisioningState === 'pending'
        || persona.lifecycleState === 'disabled'
        || persona.lifecycleState === 'error'
      ) {
        return NextResponse.json({ error: 'Persona is not available for chat.' }, { status: 409 });
      }
    }

    // Explicitly creating a conversation under an id clears any deleted-id
    // tombstone (which would otherwise silently block its persistence).
    unmarkConversationDeleted(conversationId);
    const conversationsDir = path.join(getWorkspaceDataDir(), 'db', 'conversations');
    const filePath = path.join(conversationsDir, `${conversationId}.json`);

    try {
    // Ensure the directory exists (storageService might handle this, but explicit check is safer)
    await fs.mkdir(conversationsDir, { recursive: true });

    // Check if file already exists to prevent accidental overwrite (optional but good practice)
    try {
      await fs.access(filePath);
      log.warn(`Conversation file already exists, potentially overwriting`, { requestId, conversationId, filePath });
      // Decide on behavior: return error, allow overwrite, etc. Let's allow overwrite for now.
      // return NextResponse.json({ error: `Conversation with ID ${conversationId} already exists` }, { status: 409 }); // 409 Conflict
    } catch (accessError: any) {
      if (accessError.code !== 'ENOENT') {
        throw accessError; // Re-throw unexpected errors
      }
      // File doesn't exist, proceed normally
    }

    // Create the initial SharedState
    const initialState: SharedState = {
      conversationId: conversationId,
      title: payload.title,
      // SharedState's legacy schema requires a string. An empty value means
      // "no Flow authority" until the trusted Persona dispatch installs the
      // immutable Behavior Flow immediately before execution.
      flowId: hasPersonaTarget ? '' : payload.flowId!,
      ...(hasPersonaTarget ? { personaTargetId: payload.personaTargetId } : {}),
      // Quick-Chats (issue #61): seed the in-memory flow snapshot so the engine
      // resolves the flow from the conversation state rather than the store.
      ...(payload.flowSnapshot ? { flowSnapshot: payload.flowSnapshot } : {}),
      trackingInfo: { // Initialize required tracking info
        executionId: `exec-${conversationId}-${startTime}`, // Generate an initial execution ID
        startTime: startTime,
        nodeExecutionTracker: [],
      },
      messages: [], // Start with empty messages
      status: undefined, // Initial status should be undefined or a valid state
      createdAt: payload.createdAt,
      // This control-plane create route is used by the interactive chat UI
      // (including Quick Chat / flow-generation chats). The seeded value is the
      // conversation's durable origin; runFlow preserves it across resumes.
      source: 'chat',
      updatedAt: payload.updatedAt,
      // Add other necessary initial fields from SharedState if any
      // e.g., currentStep: null, history: [], etc.
      // Removed 'variables: {}' as it's not in SharedState type
    };

    // Save the initial state via the collection API, which validates the id
    // intrinsically (assertSafeCollectionId) and resolves to the identical
    // on-disk path (db/conversations/<id>.json) — no data migration required.
    await saveCollectionItem('conversations', conversationId, initialState);
    await persistConversationSummary(conversationId, initialState);
    let targetDeletedAfterSave = false;
    if (hasPersonaTarget) {
      try {
        targetDeletedAfterSave = Boolean(
          await getPersonaDeletionTombstone(initialState.personaTargetId!),
        );
      } catch {
        // Once the target-bearing snapshot exists, an unreadable tombstone
        // store is not permission to retain it.
        targetDeletedAfterSave = true;
      }
    }
    if (targetDeletedAfterSave) {
      // Deletion can publish its tombstone after the pre-save revalidation. If
      // that happens, roll back an overwritten legacy row or retain only a
      // nonidentifying archive. The deletion scan either waits on this lease or
      // runs later, so a deleted target can never survive this boundary.
      const safeState = existingState ?? {
        ...initialState,
        personaTargetId: undefined,
        personaArchived: true as const,
      };
      if (!existingState) delete safeState.personaTargetId;
      await saveCollectionItem('conversations', conversationId, safeState);
      await persistConversationSummaryStrict(conversationId, safeState);
      return NextResponse.json(
        { error: 'Persona is being deleted or has been deleted.' },
        { status: 409 },
      );
    }
    log.info(`Successfully saved initial state for conversation`, { requestId, conversationId, filePath });

    // Prepare the response body (matching ConversationListItem)
    const responseItem: ConversationListItem = {
      id: initialState.conversationId!, // Assert non-null as it's validated from payload.id
      title: initialState.title,
      flowId: initialState.flowId || null,
      createdAt: initialState.createdAt,
      updatedAt: initialState.updatedAt,
      status: initialState.status, // This is 'running' | ... | undefined in both types
      source: initialState.source,
      ...(initialState.personaTargetId ? { personaId: initialState.personaTargetId } : {}),
    };

    const duration = Date.now() - startTime;
    log.info(`Successfully created conversation`, { requestId, conversationId, duration: `${duration}ms` });

    return NextResponse.json(responseItem, { status: 201 }); // 201 Created

    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error('Error creating conversation', {
        requestId,
        conversationId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
        duration: `${duration}ms`
      });
      return NextResponse.json({ error: 'Failed to create conversation state' }, { status: 500 });
    }
  });
}


// --- DELETE Handler (bulk) ---
// DELETE /v1/chat/conversations — bulk-delete a list of conversations by id.
// Mirrors the per-item sibling route ([conversationId]/route.ts) for each id:
// tombstone first, cancel/evict in-memory state, then remove the state file,
// conversation log, run-resources, and quick-chat compiled-flow cache. Bad
// ids are counted as errors (not fatal) so one malformed id can't abort the
// whole batch. Returns { deleted, errors }.
async function DELETE_handler(req: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(req);
  if (notLocal) return notLocal;

  const requestId = `conv-bulk-delete-${Date.now()}`;
  log.info('Handling bulk DELETE request', { requestId });

  let body: { ids?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  if (!Array.isArray(body?.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: 'Body must be { ids: string[] } with at least one id' }, { status: 400 });
  }

  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  let deleted = 0, errors = 0;
  await Promise.all((body.ids as unknown[]).map(async (rawId) => {
    if (typeof rawId !== 'string' || !SAFE_ID.test(rawId)) { errors++; return; }
    const id = rawId;
    // Preserve tombstone-first cancellation for an already-running legacy
    // execution, which owns this same lease until it observes cancellation.
    const preLockLiveState = FlowExecutor.conversationStates.get(id);
    let tombstonedBeforeLock = false;
    if (
      preLockLiveState?.status === 'running'
      && !isPersonaOwnedConversationState(preLockLiveState)
    ) {
      markConversationDeleted(id);
      tombstonedBeforeLock = true;
      preLockLiveState.isCancelled = true;
    }
    try {
      await withConversationExecutionLock(id, async () => {
        const existingState = FlowExecutor.conversationStates.get(id)
          ?? await loadCollectionItem<SharedState | undefined>('conversations', id, undefined);
        if (isPersonaOwnedConversationState(existingState)) {
          if (tombstonedBeforeLock) unmarkConversationDeleted(id);
          // Every Persona marker, including a pending target or anonymized
          // archive, is lifecycle-owned. Exposure authorization does not grant
          // generic deletion rights.
          errors++;
          return;
        }
        if (!tombstonedBeforeLock) markConversationDeleted(id);
        const mem = FlowExecutor.conversationStates.get(id);
        if (mem) {
          mem.isCancelled = true;
          // A 'running' entry must stay in the map for descendant cancellation;
          // runFlow's final cleanup drops it (tombstoned ids never re-register).
          if (mem.status !== 'running') FlowExecutor.conversationStates.delete(id);
        }
        await deleteCollectionItem('conversations', id);
        await deleteConversationLog(id);
        await deleteRunResources(id);
        await deleteConversationSummary(id);
        FlowExecutor.clearFlowCache(quickChatFlowId(id));
        deleted++;
      });
    } catch (err) {
      // Delete failed — clear the tombstone so the surviving conversation is
      // still persistable/loggable.
      unmarkConversationDeleted(id);
      log.error('Failed to delete conversation in bulk', { requestId, id, err });
      errors++;
    }
  }));

  log.info('Bulk DELETE complete', { requestId, deleted, errors });
  return NextResponse.json({ deleted, errors }, { status: 200 });
}


// Workspaces (#406): conversations are workspace-owned, so each handler runs
// inside the requested workspace. Omitting `?workspace=` selects
// `default-workspace`, which is byte-for-byte the pre-workspace behaviour for
// every existing client.
export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
