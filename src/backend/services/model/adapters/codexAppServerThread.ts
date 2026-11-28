import type { ThreadEvent, ThreadOptions, UserInput } from '@openai/codex-sdk';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration, CodexAppServerRpcError, CodexAppServerRequestError } from './codexAppServerProcess';
import { codexRecord as record, codexId as id, parseCodexProtocolUsage, assertSupportedCodexServer, codexApprovalAnswer, describeCodexTurnError, CODEX_DECLINED_ELICITATION } from './codexProtocol';
import type { CodexUsageLike } from './codexUsage';
import type { ModelContextUsage } from '@/shared/types/model/contextUsage';
import type { CodexAsyncUserInputResult } from './codexUserInput';

type Notification = { method?: string; params?: unknown };
type Child = Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
type ListedTurn = { id: string; status: string; error: unknown; items: Record<string, unknown>[] };
const STREAM_METHODS = new Set(['turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated', 'error']);
/** Sent instead of the original input when Codex already has it but its
 * answer was cut off by a lost connection. */
export const CODEX_CONTINUE_AFTER_DROP = 'Continue the interrupted response from exactly where it stopped. Do not repeat content or tool calls already completed.';
/** Lost connections one FLUJO turn reconnects after. Each reconnect first
 * confirms what Codex received; the next FLUJO turn starts with a fresh count. */
const MAX_RECONNECTS = 2;
const DROPPED = Symbol('codex-connection-dropped');
function wireInput(prompt: string | UserInput[]) {
  const entries = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt.map(entry =>
    entry.type === 'local_image' ? { type: 'localImage', path: entry.path } : entry);
  if (!entries.length || entries.length > 128 || Buffer.byteLength(JSON.stringify(entries)) > 8 * 1024 * 1024) {
    throw new Error('Codex input exceeds the supported request size.');
  }
  return entries;
}
function listedTurn(value: unknown): ListedTurn {
  const turn = record(value);
  return { id: id(turn.id), status: String(turn.status), error: turn.error,
    items: Array.isArray(turn.items) ? turn.items.map(record) : [] };
}
const transportUnavailable = (error: unknown) => error instanceof Error && error.message === 'Owned Codex app-server transport is unavailable.';

/** Ordinary owned stdio. Native Originals retain their separate admission host.
 * Every input carries its own client id. When the connection drops after an
 * input may have reached Codex, the thread reconnects and looks that id up
 * before deciding anything: an input Codex has is never sent again, an input
 * it lacks is sent once more, and anything unconfirmable ends the turn.
 */
export function createCodexAppServerThread(input: {
  executable: string; env: NodeJS.ProcessEnv; config: Record<string, unknown>; options: ThreadOptions;
  developerInstructions: string; resumeThreadId?: string; outputSchema?: Record<string, unknown>;
  /** Codex speed tier for this thread (`default` or a tier the model lists). */
  serviceTier?: string;
  fork?: { threadId: string; lastTurnId: string; sessionId?: string };
  onUsage(total: CodexUsageLike, context: ModelContextUsage): void;
  /** Account-wide plan limits Codex reports during a run (one bucket per call). */
  onRateLimits?(rateLimits: unknown): void;
  onQuestion?(questions: unknown, signal: AbortSignal): Promise<unknown>;
  onAsyncQuestion?(questions: unknown, signal: AbortSignal): Promise<CodexAsyncUserInputResult>;
  beforeContinuation?(): Promise<void>;
  /** What FLUJO re-sends word for word whenever Codex compacts this
   * conversation: standing user instructions and receipts (#1091). */
  compactionCarry?(): string | undefined;
  /** Codex compacted but did not take the carry; the thread must not be reused. */
  onCompactionCarryLost?(): void;
  maxTurns?: number;
}) {
  if (input.fork && input.resumeThreadId) throw new Error('Codex cannot fork and resume in the same dispatch.');
  const owner = Object.freeze({});
  let child: Child | undefined, threadId = input.resumeThreadId, activeTurnId: string | undefined;
  let childCloseProof: Promise<void> | undefined;
  let closed = false, running = false, reconnecting = false;
  let awaitingAsyncInput = false;
  let closing: Promise<void> | undefined;
  let opening: Promise<void> | undefined;
  const lifecycle = new AbortController();
  const queue: Notification[] = [];
  let queueBytes = 0, wake: (() => void) | undefined;
  let streamFailure: Error | undefined;
  const messageText = new Map<string, string>();
  let totalUsage: CodexUsageLike | undefined;
  let usageUnknown = false;
  let completedTurnId: string | undefined;
  let nativeSessionId: string | undefined;
  let runtimeVersion: string | undefined;
  let resumedTurnIds = new Set<string>();
  const endedTurns = new Set<string>();
  /** Steers whose answer was lost with the connection, settled once the
   * reconnect has looked their client ids up. */
  const unconfirmedSteers = new Map<string, (found: boolean | Error) => void>();
  const enqueue = (message: Notification) => {
    // Legacy/diagnostic notifications are not consumed by this adapter. Do not
    // let their duplicate output exhaust the bounded application-event queue.
    if (!STREAM_METHODS.has(message.method ?? '')) return;
    const previous = queue.at(-1);
    const params = record(message.params), prior = previous ? record(previous.params) : {};
    if (message.method === 'item/agentMessage/delta' && previous?.method === message.method
      && params.threadId === prior.threadId && params.turnId === prior.turnId && params.itemId === prior.itemId
      && typeof params.delta === 'string' && typeof prior.delta === 'string') {
      const combined = { ...message, params: { ...params, delta: prior.delta + params.delta } };
      const bytes = Buffer.byteLength(JSON.stringify(combined));
      const nextBytes = queueBytes - Buffer.byteLength(JSON.stringify(previous)) + bytes;
      if (nextBytes > 8 * 1024 * 1024) {
        streamFailure = new Error('Codex output exceeded the stream buffer.');
        throw streamFailure;
      }
      queue[queue.length - 1] = combined;
      queueBytes = nextBytes;
      wake?.();
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (queue.length >= 2048 || queueBytes + bytes > 8 * 1024 * 1024) {
      streamFailure = new Error('Codex output exceeded the stream buffer.');
      throw streamFailure;
    }
    queue.push(message); queueBytes += bytes; wake?.();
  };
  /** The newest turns, oldest first. Codex 0.164+ pages history through
   * thread/turns/list; a Codex that still returns full history inline (it
   * ignores excludeTurns) is read from the response instead. */
  const latestTurns = async (current: Child, thread: string, response: Record<string, unknown>,
    limit: number, itemsView: 'summary' | 'full'): Promise<ListedTurn[]> => {
    const inline = record(response.thread).turns;
    if (Array.isArray(inline) && inline.length) return inline.slice(-limit).map(listedTurn);
    let page: Record<string, unknown>;
    try {
      page = record(await current.request('thread/turns/list', { threadId: thread, limit, sortDirection: 'desc', itemsView }));
    } catch (error) {
      // An older Codex without the turn list: nothing to skip or confirm.
      if (error instanceof CodexAppServerRpcError && Array.isArray(inline)) return [];
      throw error;
    }
    if (!Array.isArray(page.data) || page.data.length > limit) throw new Error('Invalid Codex turn list.');
    return page.data.map(listedTurn).reverse();
  };
  const startChild = async () => {
    // Features that create the CLI's code host are selected at process startup;
    // thread/start overrides alone do not remove that already-created host.
    const features = input.config.features === undefined ? {} : record(input.config.features);
    const startupPolicy = Object.entries(features).flatMap(([name, enabled]) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof enabled !== 'boolean') throw new Error('Invalid ordinary Codex feature policy.');
      return ['-c', `features.${name}=${enabled}`];
    });
    return startOwnedCodexAppServer({ executable: input.executable, args: [...startupPolicy,
      ...(input.config.forced_login_method === 'chatgpt' ? ['-c', 'forced_login_method="chatgpt"'] : []),
      '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
      '-c', `tools.experimental_request_user_input.enabled=${Boolean(input.onQuestion || input.onAsyncQuestion)}`,
      '-c', `features.default_mode_request_user_input=${Boolean(input.onQuestion || input.onAsyncQuestion)}`, 'app-server'],
      env: input.env, cwd: input.options.workingDirectory!, owner, signal: lifecycle.signal,
      register: async registration => {
        assertCodexOwnedProcessRegistration(registration, owner);
        childCloseProof = registration.close;
      },
      // A connection FLUJO replaces is told to stop first; the transport
      // delivers nothing from it after that.
      onNotification: message => {
        if (message.method === 'account/rateLimits/updated') {
          // Account telemetry, not conversation output: it has no thread or
          // turn, and a failing reader must never end the user's run.
          try { input.onRateLimits?.(record(message.params).rateLimits); } catch { /* Telemetry only. */ }
          return;
        }
        if (message.method === 'turn/completed') {
          const params = record(message.params);
          if (params.threadId === threadId) {
            endedTurns.add(id(record(params.turn).id));
            if (endedTurns.size > 128) throw new Error('Codex exceeded the supported turn count.');
            if (endedTurns.has(activeTurnId!)) activeTurnId = undefined;
          }
        }
        enqueue(message);
      },
      onRequest: async (request, signal) => {
        const params = record(request.params);
        const expectedTurnId = activeTurnId, expectedThreadId = threadId;
        const owned = !closed && !signal.aborted && Boolean(expectedTurnId) && !endedTurns.has(expectedTurnId!)
          && params.threadId === expectedThreadId;
        // Codex's own approval prompts get a typed answer, never a transport
        // error. Declining is always safe; passing a FLUJO tool on to FLUJO's
        // gate needs the active turn (an MCP prompt may not name its turn).
        const approval = codexApprovalAnswer(request.method, params);
        if (approval) {
          if (!approval.forwardToFlujoGate) return approval.result;
          if (owned && (params.turnId == null || params.turnId === expectedTurnId)) return approval.result;
          return CODEX_DECLINED_ELICITATION;
        }
        if (!owned || !expectedTurnId || params.turnId !== expectedTurnId) {
          throw new CodexAppServerRequestError(-32602, 'User input does not belong to the active FLUJO turn.');
        }
        if (request.method !== 'item/tool/requestUserInput' || !input.onQuestion) {
          throw new CodexAppServerRequestError(-32601, 'This server action is not enabled in the FLUJO flow.');
        }
        id(params.itemId);
        const result = await input.onQuestion(params.questions, signal);
        if (closed || signal.aborted || activeTurnId !== expectedTurnId || threadId !== expectedThreadId || endedTurns.has(expectedTurnId)) {
          throw new CodexAppServerRequestError(-32602, 'The FLUJO turn ended before this answer.');
        }
        return result;
      },
    });
  };
  /** Newest turns read by the last open (resume/fork), oldest first. */
  let listedTurns: ListedTurn[] = [];
  const open = async (itemsView: 'summary' | 'full' = 'summary') => {
    if (closed) throw new Error('Codex conversation is closed.');
    if (child) return;
    if (opening) return opening;
    opening = (async () => {
    const started = await startChild();
    child = started;
    if (closed) { await started.stop(); throw new Error('Codex conversation was cancelled during startup.'); }
    const initialized = await started.request('initialize', { clientInfo: { name: 'flujo_conversation', title: 'FLUJO', version: '1' },
      ...(input.onQuestion || input.onAsyncQuestion ? { capabilities: { experimentalApi: true } } : {}),
    });
    // A too-old program is refused before any thread exists, so no input is sent.
    runtimeVersion = assertSupportedCodexServer(initialized);
    started.notify('initialized');
    const params = { model: input.options.model, cwd: input.options.workingDirectory,
      approvalPolicy: 'never', sandbox: 'read-only', config: input.config,
      developerInstructions: input.developerInstructions,
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    };
    const forking = Boolean(input.fork && !threadId);
    const method = forking ? 'thread/fork' : threadId ? 'thread/resume' : 'thread/start';
    // Full history in resume/fork answers is deprecated for paged threads;
    // the newest turns come from thread/turns/list instead.
    const response = record(await started.request(method, {
      ...params, ...(forking ? { threadId: id(input.fork!.threadId), lastTurnId: id(input.fork!.lastTurnId), ephemeral: false, excludeTurns: true }
        : threadId ? { threadId, excludeTurns: true } : { ephemeral: false }),
    }));
    const received = id(record(response.thread).id);
    if (threadId && received !== threadId) throw new Error('Codex resumed a different conversation.');
    const priorTurns = method === 'thread/start' ? [] : await latestTurns(started, received, response, 4, itemsView);
    listedTurns = priorTurns;
    resumedTurnIds = new Set(priorTurns.map(turn => turn.id));
    if (forking) {
      const boundary = priorTurns.at(-1);
      const receivedSessionId = record(response.thread).sessionId;
      if (received === input.fork!.threadId || record(response.thread).forkedFromId !== input.fork!.threadId
        || boundary?.id !== input.fork!.lastTurnId || boundary.status !== 'completed'
        || typeof receivedSessionId !== 'string'
        || (receivedSessionId !== received && receivedSessionId !== input.fork!.sessionId)) {
        throw new Error('Codex fork did not preserve the requested completed-turn boundary and lineage.');
      }
      const cwd = typeof response.cwd === 'string' ? path.resolve(response.cwd) : '';
      const expectedCwd = path.resolve(input.options.workingDirectory!);
      if (response.model !== input.options.model || response.approvalPolicy !== 'never' || record(response.sandbox).type !== 'readOnly'
        || (process.platform === 'win32' ? cwd.toLowerCase() !== expectedCwd.toLowerCase() : cwd !== expectedCwd)) {
        throw new Error('Codex fork did not preserve the ordinary model, permission policy and workspace.');
      }
    }
    if (response.model != null && response.model !== input.options.model) throw new Error('Codex selected a different model.');
    if (record(response.thread).sessionId != null) nativeSessionId = id(record(response.thread).sessionId);
    threadId = received;
    })();
    await opening;
  };
  /** Start a new connection after the old one ended without FLUJO closing it.
   * The thread is resumed, never restarted, once Codex has named it. */
  const reconnect = async () => {
    const previous = child;
    reconnecting = true;
    try {
      if (previous) {
        previous.registration.requestStop();
        await previous.stop();
      }
      if (closed) throw new Error('Codex conversation closed before completion.');
      child = undefined; opening = undefined; activeTurnId = undefined;
      // Full items: the reconnect looks FLUJO's inputs up by their client ids.
      await open('full');
    } finally { reconnecting = false; }
  };
  const close = async () => {
    if (closing) return closing;
    closed = true;
    activeTurnId = undefined;
    wake?.();
    lifecycle.abort();
    for (const settle of unconfirmedSteers.values()) settle(new Error('Codex conversation closed before the steering input was confirmed.'));
    unconfirmedSteers.clear();
    closing = (async () => {
      // Birth/admission owns a child before open() returns it. Drain that owner
      // before reporting closure, even when cancellation interrupts admission.
      try { await opening; } catch (error) {
        // Aggregate startup failures include unconfirmed process closure.
        if (error instanceof AggregateError) throw error;
      }
      await child?.stop();
    })();
    await closing;
  };
  return Object.freeze({
    close,
    whenClosed: () => childCloseProof ?? child?.registration.close,
    usage: () => totalUsage,
    /** True when a turn recovered after a lost connection never reported its totals. */
    usageUnknown: () => usageUnknown,
    completedTurnId: () => completedTurnId,
    nativeSessionId: () => nativeSessionId,
    /** Version the running app-server reported, once it has started. */
    runtimeVersion: () => runtimeVersion,
    canSteer: () => Boolean(child && activeTurnId && !closed && !awaitingAsyncInput && !reconnecting),
    /** Only a received rejection, or a reconnect that found the input missing,
     * permits returning input to the pending inbox. */
    async steer(prompt: string | UserInput[]): Promise<boolean> {
      if (!child || !threadId || !activeTurnId || closed || awaitingAsyncInput || reconnecting) return false;
      const expectedTurnId = activeTurnId, clientUserMessageId = randomUUID();
      try {
        const response = record(await child.request('turn/steer', { threadId, expectedTurnId, input: wireInput(prompt), clientUserMessageId }));
        if (response.turnId !== expectedTurnId) throw new Error('Codex steering acknowledgement did not match the active turn.');
        return true;
      } catch (error) {
        if (error instanceof CodexAppServerRpcError) return false;
        if (running && !closed && transportUnavailable(error)) {
          // The running turn reconnects and tells whether Codex has this input.
          const found = await new Promise<boolean | Error>(settle => unconfirmedSteers.set(clientUserMessageId, settle));
          if (typeof found === 'boolean') return found;
          error = found;
        }
        await close();
        throw error;
      }
    },
    async runStreamed(prompt: string | UserInput[], options: { signal?: AbortSignal }) {
      const events = (async function* (): AsyncGenerator<ThreadEvent> {
        if (running) throw new Error('A Codex turn is already active.');
        running = true;
        const abort = () => {
          // Interrupt targets exactly the owned turn, then close even if RPC fails.
          wake?.();
          void (async () => {
            try { if (child && threadId && activeTurnId) await child.request('turn/interrupt', { threadId, turnId: activeTurnId }, 5000); }
            catch { /* Child closure is still mandatory. */ }
            finally { await close(); }
          })().catch(() => {});
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        let questionController: AbortController | undefined;
        const cancelQuestion = () => questionController?.abort();
        lifecycle.signal.addEventListener('abort', cancelQuestion);
        options.signal?.addEventListener('abort', cancelQuestion);
        let finished = false;
        let reconnects = 0;
        const cancelled = () => Boolean(closed || options.signal?.aborted || lifecycle.signal.aborted);
        /** A lost connection FLUJO did not cause, while input may be in flight. */
        const isDrop = (error: unknown) => !(error instanceof CodexAppServerRpcError) && !cancelled() && !streamFailure
          && transportUnavailable(error);
        const yieldedItems = new Set<string>();
        try {
          options.signal?.throwIfAborted();
          for (let attempt = 0; ; attempt++) {
            try { await open(); break; } catch (error) {
              // Nothing has been sent yet, so one fresh start is always safe.
              if (attempt || cancelled() || !transportUnavailable(error)) throw error;
              child?.registration.requestStop();
              await child?.stop();
              child = undefined; opening = undefined;
            }
          }
          options.signal?.throwIfAborted();
          yield { type: 'thread.started', thread_id: threadId! };
          let nextInput = prompt;
          let turnCount = 0;
          const maxTurns = Number.isSafeInteger(input.maxTurns) && input.maxTurns! > 0 ? Math.min(input.maxTurns!, 128) : 128;
          /** After a drop: reconnect, then find which of these client ids Codex
           * recorded, and the turn that holds the first one. */
          const confirm = async (clientIds: string[]) => {
            if (++reconnects > MAX_RECONNECTS || !threadId) {
              throw new Error('Codex lost its connection again, so FLUJO could not confirm what Codex received. FLUJO did not send the input again.');
            }
            await reconnect();
            const wanted = new Set([...clientIds, ...unconfirmedSteers.keys()]);
            const found = new Set<string>();
            let turn: ListedTurn | undefined;
            for (const candidate of listedTurns) for (const item of candidate.items) {
              if (item.type !== 'userMessage' || typeof item.clientId !== 'string' || !wanted.has(item.clientId)) continue;
              found.add(item.clientId);
              if (item.clientId === clientIds[0]) turn = candidate;
            }
            for (const [clientId, settle] of unconfirmedSteers) settle(found.has(clientId));
            unconfirmedSteers.clear();
            return { turn, found };
          };
          turns: while (true) {
            options.signal?.throwIfAborted();
            lifecycle.signal.throwIfAborted();
            if (turnCount) await input.beforeContinuation?.();
            options.signal?.throwIfAborted();
            lifecycle.signal.throwIfAborted();
            turnCount++;
            completedTurnId = undefined;
            const clientUserMessageId = randomUUID();
            const turnStart = () => child!.request('turn/start', { threadId,
              model: input.options.model, effort: input.options.modelReasoningEffort,
              input: wireInput(nextInput), clientUserMessageId, ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
            });
            let currentTurnId: string | undefined;
            let recovered: ListedTurn | undefined;
            let carry: { clientId: string } | undefined;
            const carryLost = () => { if (carry) { carry = undefined; input.onCompactionCarryLost?.(); } };
            /** Resolve a drop: the turn Codex holds for this input, or one
             * resend of an input Codex confirmed it does not have. */
            const settleDrop = async (): Promise<void> => {
              while (true) {
                const { turn, found } = await confirm([clientUserMessageId, ...(carry ? [carry.clientId] : [])]);
                if (carry && !found.has(carry.clientId)) carryLost();
                if (turn) { recovered = turn; currentTurnId = turn.id; return; }
                try { currentTurnId = id(record(record(await turnStart()).turn).id); return; } catch (error) {
                  if (!isDrop(error)) throw error;
                }
              }
            };
            try {
              currentTurnId = id(record(record(await turnStart()).turn).id);
            } catch (error) {
              if (!isDrop(error)) throw error;
              await settleDrop();
            }
            if (!recovered) activeTurnId = endedTurns.has(currentTurnId!) ? undefined : currentTurnId;
            const activeTools = new Set<string>();
            let pendingQuestion: { questions: unknown } | undefined;
            let questionTerminalDeadline: number | undefined;
            const questionItems = new Set<string>();
            yield { type: 'turn.started' };
            while (true) {
              options.signal?.throwIfAborted();
              if (recovered) {
                // Codex already holds this input. Show what it answered that
                // FLUJO had not seen, then finish or continue that turn.
                const turn = recovered;
                recovered = undefined;
                activeTurnId = undefined;
                resumedTurnIds.add(turn.id);
                for (const item of turn.items) {
                  if (item.type !== 'agentMessage' || typeof item.text !== 'string' || item.questions != null) continue;
                  const itemId = id(item.id);
                  if (yieldedItems.has(itemId)) continue;
                  yieldedItems.add(itemId);
                  messageText.delete(itemId);
                  yield { type: 'item.completed', item: { id: itemId, type: 'agent_message', text: item.text,
                    ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}),
                  } };
                }
                if (turn.status === 'completed') {
                  completedTurnId = turn.id;
                  // The reconnect replays this turn's totals when Codex has them;
                  // otherwise its usage is unknown, never guessed.
                  const replayed = queue.find(message => message.method === 'thread/tokenUsage/updated'
                    && record(message.params).turnId === turn.id);
                  if (replayed) {
                    const usage = parseCodexProtocolUsage(record(replayed.params).tokenUsage);
                    totalUsage = usage.total;
                    input.onUsage(usage.total, usage.context);
                  } else usageUnknown = true;
                  yield { type: 'turn.completed', usage: totalUsage ?? { input_tokens: 0, output_tokens: 0 } } as ThreadEvent;
                  finished = true;
                  break turns;
                }
                if (turn.status === 'failed' && turn.error != null) {
                  yield { type: 'turn.failed', error: { message: describeCodexTurnError(turn.error) } };
                  finished = true;
                  break turns;
                }
                if (turn.status !== 'interrupted' && turn.status !== 'failed') {
                  throw new Error('Codex still reports this turn as running elsewhere, so FLUJO could not confirm it. FLUJO did not send the input again.');
                }
                if (turnCount >= maxTurns) throw new Error('Codex reached the flow turn limit before the interrupted answer could continue.');
                nextInput = CODEX_CONTINUE_AFTER_DROP;
                messageText.clear();
                continue turns;
              }
              if (questionTerminalDeadline && !endedTurns.has(currentTurnId!) && Date.now() >= questionTerminalDeadline) {
                throw new Error('Codex question interrupt had no confirmed terminal; no answer was submitted.');
              }
              if (!queue.length) {
                let terminalTimer: ReturnType<typeof setTimeout> | undefined;
                let woke: unknown;
                try {
                  woke = await Promise.race([
                    new Promise<void>(resolve => { wake = resolve; if (queue.length || options.signal?.aborted || closed) resolve(); }),
                    child!.registration.close.then(() => DROPPED),
                    ...(questionTerminalDeadline ? [new Promise<never>((_resolve, reject) => {
                      terminalTimer = setTimeout(() => reject(new Error('Codex question interrupt had no confirmed terminal; no answer was submitted.')),
                        Math.max(1, questionTerminalDeadline! - Date.now()));
                    })] : []),
                  ]);
                } finally { if (terminalTimer) clearTimeout(terminalTimer); }
                wake = undefined;
                options.signal?.throwIfAborted();
                if (closed) throw new Error('Codex conversation closed before completion.');
                if (woke === DROPPED && !queue.length) {
                  if (streamFailure) throw streamFailure;
                  // A question already asked is the user's turn now; never
                  // confirm and continue it on a new connection.
                  if (pendingQuestion || awaitingAsyncInput) throw new Error('Codex connection closed; the user answer was not submitted.');
                  await settleDrop();
                  activeTools.clear();
                  if (!recovered) activeTurnId = endedTurns.has(currentTurnId!) ? undefined : currentTurnId;
                  continue;
                }
              }
              const message = queue.shift();
              if (!message) continue;
              queueBytes -= Buffer.byteLength(JSON.stringify(message));
              const method = message.method;
              if (!STREAM_METHODS.has(method ?? '')) continue;
              const params = record(message.params);
              if (params.threadId !== threadId) throw new Error('Codex emitted output for a different conversation.');
              const turnId = method === 'turn/completed' ? record(params.turn).id : params.turnId;
              // Resume can publish the last committed turn's usage before turn/start.
              // Its identity is established by the canonical resume response.
              if (method === 'thread/tokenUsage/updated' && typeof turnId === 'string' && resumedTurnIds.has(turnId)) continue;
              if (turnId !== currentTurnId) throw new Error('Codex emitted output for a different turn.');
              if (method === 'thread/tokenUsage/updated') {
                const usage = parseCodexProtocolUsage(params.tokenUsage);
                totalUsage = usage.total;
                input.onUsage(usage.total, usage.context);
              } else if (method === 'item/agentMessage/delta') {
                const itemId = id(params.itemId);
                if (typeof params.delta !== 'string') throw new Error('Invalid Codex message delta.');
                const text = (messageText.get(itemId) ?? '') + params.delta;
                if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Codex message exceeded the supported size.');
                messageText.set(itemId, text);
                yield { type: 'item.updated', item: { id: itemId, type: 'agent_message', text } };
              } else if (method === 'item/started' || method === 'item/completed') {
                const item = record(params.item), itemId = id(item.id);
                const type = method === 'item/started' ? 'item.started' : 'item.completed';
                if (item.type === 'agentMessage') {
                  if (typeof item.text !== 'string') throw new Error('Invalid Codex message.');
                  if (item.questions != null) {
                    if (!input.onAsyncQuestion || item.delivery !== 'async' || !Array.isArray(item.questions)) {
                      throw new Error('Codex requested user input that is not enabled in this FLUJO flow.');
                    }
                    // The generated question prose is represented by the local
                    // canonical question call/result, rather than a second final answer.
                    if (method === 'item/started') continue;
                    if (pendingQuestion || questionItems.has(itemId) || activeTools.size) {
                      throw new Error('Codex requested overlapping user input or tool execution.');
                    }
                    if (turnCount >= maxTurns) throw new Error('Codex reached the flow turn limit before user input could continue.');
                    questionItems.add(itemId);
                    awaitingAsyncInput = true;
                    questionController = new AbortController();
                    if (options.signal?.aborted || lifecycle.signal.aborted) questionController.abort();
                    // An interrupt acknowledgement is insufficient to start a new
                    // turn. The matching typed terminal is consumed below first.
                    if (!endedTurns.has(currentTurnId!)) {
                      try { await child!.request('turn/interrupt', { threadId, turnId: currentTurnId }, 5000); }
                      catch (error) {
                        // A received rejection can race natural completion.
                        // Only a matching valid terminal below permits input.
                        if (!(error instanceof CodexAppServerRpcError)) throw error;
                      }
                    }
                    questionController.signal.throwIfAborted();
                    pendingQuestion = { questions: item.questions };
                    questionTerminalDeadline = Date.now() + 5000;
                    continue;
                  }
                  messageText.set(itemId, item.text);
                  if (type === 'item.completed') yieldedItems.add(itemId);
                  yield { type, item: { id: itemId, type: 'agent_message', text: item.text,
                    ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}),
                  } };
                  if (type === 'item.completed') messageText.delete(itemId);
                } else if (item.type === 'mcpToolCall') {
                  // Codex's built-in cross-server discovery uses the synthetic
                  // server name "codex". It only lists the MCP servers in this
                  // isolated runtime; it is not an invocation of another tool
                  // server. In particular this exception must not admit reads,
                  // arbitrary tools, or discovery targeting an unbound server.
                  const discovery = item.server === 'codex'
                    && ['list_mcp_resources', 'list_mcp_resource_templates'].includes(String(item.tool))
                    && (item.arguments == null || (typeof item.arguments === 'object'
                      && !Array.isArray(item.arguments) && record(item.arguments).server == null));
                  if ((!discovery && item.server !== 'flujo') || typeof item.tool !== 'string'
                    || !['inProgress', 'completed', 'failed'].includes(String(item.status))) throw new Error('Unexpected Codex tool execution.');
                  if (pendingQuestion) throw new Error('Codex continued tool execution while awaiting user input.');
                  if (item.status === 'inProgress') activeTools.add(itemId); else activeTools.delete(itemId);
                  yield { type, item: { ...item, id: itemId, type: 'mcp_tool_call', status: item.status === 'inProgress' ? 'in_progress' : item.status } } as ThreadEvent;
                } else if (item.type === 'contextCompaction') {
                  // Codex's own summary decides alone what it keeps. Re-send
                  // FLUJO's standing instructions and receipts into this turn,
                  // where Codex adds them right after the compacted history.
                  const text = method === 'item/started' && !carry ? input.compactionCarry?.() : undefined;
                  if (text) {
                    carry = { clientId: randomUUID() };
                    try {
                      const accepted = record(await child!.request('turn/steer', { threadId, expectedTurnId: currentTurnId,
                        input: wireInput(text), clientUserMessageId: carry.clientId }));
                      if (accepted.turnId !== currentTurnId) carryLost();
                    } catch (error) {
                      if (error instanceof CodexAppServerRpcError) carryLost();
                      else if (!isDrop(error)) throw error;
                    }
                  }
                } else if (item.type === 'userMessage') {
                  if (carry && item.clientId === carry.clientId && method === 'item/started') carry = undefined;
                } else if (item.type !== 'reasoning') {
                  const itemType = typeof item.type === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(item.type) ? ` (${item.type})` : '';
                  throw new Error(`Codex emitted an unsupported item${itemType}. Update the FLUJO integration before continuing.`);
                }
              } else if (method === 'error') {
                if (params.willRetry !== true) throw new Error(describeCodexTurnError(params.error));
              } else {
                const turn = record(params.turn);
                activeTurnId = undefined;
                // Codex dropped the carry it accepted: never reuse this thread.
                carryLost();
                if (pendingQuestion) {
                  if (turn.status !== 'completed' && turn.status !== 'interrupted') {
                    throw new Error('Codex question turn did not reach a valid terminal; no answer was submitted.');
                  }
                  questionTerminalDeadline = undefined;
                  options.signal?.throwIfAborted();
                  lifecycle.signal.throwIfAborted();
                  const questionAnswer = input.onAsyncQuestion!(pendingQuestion.questions, questionController!.signal)
                    .then(result => ({ result }), error => ({ error }));
                  const answered = await Promise.race([questionAnswer,
                    child!.registration.close.then(() => { throw new Error('Codex connection closed; the user answer was not submitted.'); }),
                  ]);
                  options.signal?.throwIfAborted();
                  lifecycle.signal.throwIfAborted();
                  if ('error' in answered) throw answered.error;
                  if (answered.result.action === 'decline') {
                    finished = true;
                    yield { type: 'turn.completed', usage: totalUsage ?? { input_tokens: 0, output_tokens: 0 } } as ThreadEvent;
                    break turns;
                  }
                  if (!['answer', 'unanswered'].includes(answered.result.action) || typeof answered.result.text !== 'string' || !answered.result.text.trim()) {
                    throw new Error('Codex user input had no response.');
                  }
                  nextInput = answered.result.text;
                  // Late totals for this confirmed turn are expected on the same
                  // connection. Its other output still cannot enter the new turn.
                  resumedTurnIds.add(currentTurnId!);
                  questionController = undefined;
                  awaitingAsyncInput = false;
                  messageText.clear();
                  continue turns;
                }
                if (turn.status === 'completed') {
                  if (activeTools.size) throw new Error('Codex completed with unresolved MCP work; this turn cannot be a fork checkpoint.');
                  completedTurnId = currentTurnId;
                  // Usage can be absent; absence must not erase protocol totals or fabricate entitlement.
                  yield { type: 'turn.completed', usage: totalUsage ?? { input_tokens: 0, output_tokens: 0 } } as ThreadEvent;
                } else if (turn.status === 'failed' || turn.status === 'interrupted') {
                  yield { type: 'turn.failed', error: { message: turn.status === 'interrupted' ? 'Codex turn was interrupted.'
                    : turn.error != null ? describeCodexTurnError(turn.error) : 'Codex turn failed.' } };
                } else throw new Error('Invalid Codex terminal status.');
                finished = true;
                break turns;
              }
            }
          }
        } finally {
          cancelQuestion();
          lifecycle.signal.removeEventListener('abort', cancelQuestion);
          options.signal?.removeEventListener('abort', cancelQuestion);
          options.signal?.removeEventListener('abort', abort);
          running = false;
          awaitingAsyncInput = false;
          for (const settle of unconfirmedSteers.values()) settle(new Error('Codex turn ended before the steering input was confirmed.'));
          unconfirmedSteers.clear();
          if (!finished || options.signal?.aborted || activeTurnId) await close();
        }
      })();
      return { events };
    },
  });
}
