import type { ThreadEvent, ThreadOptions, UserInput } from '@openai/codex-sdk';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration, CodexAppServerRpcError, CodexAppServerRequestError } from './codexAppServerProcess';
import { codexRecord as record, codexId as id, parseCodexProtocolUsage } from './codexProtocol';
import type { CodexUsageLike } from './codexUsage';
import type { ModelContextUsage } from '@/shared/types/model/contextUsage';
import type { CodexAsyncUserInputResult } from './codexUserInput';

type Notification = { method?: string; params?: unknown };
type Child = Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
function wireInput(prompt: string | UserInput[]) {
  const entries = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt.map(entry =>
    entry.type === 'local_image' ? { type: 'localImage', path: entry.path } : entry);
  if (!entries.length || entries.length > 128 || Buffer.byteLength(JSON.stringify(entries)) > 8 * 1024 * 1024) {
    throw new Error('Codex input exceeds the supported request size.');
  }
  return entries;
}

/** Ordinary owned stdio. Native Originals retain their separate admission host.
 * No reconnect replay: an uncertain submission terminates this invocation.
 */
export function createCodexAppServerThread(input: {
  executable: string; env: NodeJS.ProcessEnv; config: Record<string, unknown>; options: ThreadOptions;
  developerInstructions: string; resumeThreadId?: string; outputSchema?: Record<string, unknown>;
  onUsage(total: CodexUsageLike, context: ModelContextUsage): void;
  onQuestion?(questions: unknown, signal: AbortSignal): Promise<unknown>;
  onAsyncQuestion?(questions: unknown, signal: AbortSignal): Promise<CodexAsyncUserInputResult>;
  beforeContinuation?(): Promise<void>;
  maxTurns?: number;
}) {
  const owner = Object.freeze({});
  let child: Child | undefined, threadId = input.resumeThreadId, activeTurnId: string | undefined;
  let childCloseProof: Promise<void> | undefined;
  let closed = false, running = false;
  let awaitingAsyncInput = false;
  let closing: Promise<void> | undefined;
  let opening: Promise<void> | undefined;
  const lifecycle = new AbortController();
  const queue: Notification[] = [];
  let queueBytes = 0, wake: (() => void) | undefined;
  const messageText = new Map<string, string>();
  let totalUsage: CodexUsageLike | undefined;
  let resumedTurnIds = new Set<string>();
  const endedTurns = new Set<string>();
  const enqueue = (message: Notification) => {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (queue.length >= 2048 || queueBytes + bytes > 8 * 1024 * 1024) throw new Error('Codex output exceeded the stream buffer.');
    queue.push(message); queueBytes += bytes; wake?.();
  };
  const open = async () => {
    if (closed) throw new Error('Codex conversation is closed.');
    if (child) return;
    if (opening) return opening;
    opening = (async () => {
    // Features that create the CLI's code host are selected at process startup;
    // thread/start overrides alone do not remove that already-created host.
    const features = input.config.features === undefined ? {} : record(input.config.features);
    const startupPolicy = Object.entries(features).flatMap(([name, enabled]) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof enabled !== 'boolean') throw new Error('Invalid ordinary Codex feature policy.');
      return ['-c', `features.${name}=${enabled}`];
    });
    child = await startOwnedCodexAppServer({ executable: input.executable, args: [...startupPolicy,
      '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
      '-c', `tools.experimental_request_user_input.enabled=${Boolean(input.onQuestion || input.onAsyncQuestion)}`,
      '-c', `features.default_mode_request_user_input=${Boolean(input.onQuestion || input.onAsyncQuestion)}`, 'app-server'],
      env: input.env, cwd: input.options.workingDirectory!, owner, signal: lifecycle.signal,
      register: async registration => {
        assertCodexOwnedProcessRegistration(registration, owner);
        childCloseProof = registration.close;
      },
      onNotification: message => {
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
        if (closed || signal.aborted || !expectedTurnId || endedTurns.has(expectedTurnId)
          || params.threadId !== expectedThreadId || params.turnId !== expectedTurnId) {
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
    if (closed) { await child.stop(); throw new Error('Codex conversation was cancelled during startup.'); }
    await child.request('initialize', { clientInfo: { name: 'flujo_conversation', title: 'FLUJO', version: '1' },
      ...(input.onQuestion || input.onAsyncQuestion ? { capabilities: { experimentalApi: true } } : {}),
    });
    child.notify('initialized');
    const params = { model: input.options.model, cwd: input.options.workingDirectory,
      approvalPolicy: 'never', sandbox: 'read-only', config: input.config,
      developerInstructions: input.developerInstructions,
    };
    const response = record(await child.request(threadId ? 'thread/resume' : 'thread/start', {
      ...params, ...(threadId ? { threadId } : { ephemeral: false }),
    }));
    const received = id(record(response.thread).id);
    const priorTurns = record(response.thread).turns;
    resumedTurnIds = new Set(Array.isArray(priorTurns) ? priorTurns.map(turn => id(record(turn).id)) : []);
    if (threadId && received !== threadId) throw new Error('Codex resumed a different conversation.');
    if (response.model != null && response.model !== input.options.model) throw new Error('Codex selected a different model.');
    threadId = received;
    })();
    await opening;
  };
  const close = async () => {
    if (closing) return closing;
    closed = true;
    activeTurnId = undefined;
    wake?.();
    lifecycle.abort();
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
    canSteer: () => Boolean(child && activeTurnId && !closed && !awaitingAsyncInput),
    /** Only a received rejection permits returning input to the pending inbox. */
    async steer(prompt: string | UserInput[]): Promise<boolean> {
      if (!child || !threadId || !activeTurnId || closed || awaitingAsyncInput) return false;
      const expectedTurnId = activeTurnId;
      try {
        const response = record(await child.request('turn/steer', { threadId, expectedTurnId, input: wireInput(prompt) }));
        if (response.turnId !== expectedTurnId) throw new Error('Codex steering acknowledgement did not match the active turn.');
        return true;
      } catch (error) {
        if (error instanceof CodexAppServerRpcError) return false;
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
        try {
          options.signal?.throwIfAborted();
          await open();
          options.signal?.throwIfAborted();
          yield { type: 'thread.started', thread_id: threadId! };
          let nextInput = prompt;
          let turnCount = 0;
          const maxTurns = Number.isSafeInteger(input.maxTurns) && input.maxTurns! > 0 ? Math.min(input.maxTurns!, 128) : 128;
          turns: while (true) {
            options.signal?.throwIfAborted();
            lifecycle.signal.throwIfAborted();
            if (turnCount) await input.beforeContinuation?.();
            options.signal?.throwIfAborted();
            lifecycle.signal.throwIfAborted();
            turnCount++;
            const response = record(await child!.request('turn/start', { threadId,
              model: input.options.model, effort: input.options.modelReasoningEffort,
              input: wireInput(nextInput), ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
            }));
            const currentTurnId = id(record(response.turn).id);
            activeTurnId = endedTurns.has(currentTurnId) ? undefined : currentTurnId;
            const activeTools = new Set<string>();
            let pendingQuestion: { questions: unknown } | undefined;
            let questionTerminalDeadline: number | undefined;
            const questionItems = new Set<string>();
            yield { type: 'turn.started' };
            while (true) {
              options.signal?.throwIfAborted();
              if (questionTerminalDeadline && !endedTurns.has(currentTurnId) && Date.now() >= questionTerminalDeadline) {
                throw new Error('Codex question interrupt had no confirmed terminal; no answer was submitted.');
              }
              if (!queue.length) {
                let terminalTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                  await Promise.race([
                    new Promise<void>(resolve => { wake = resolve; if (queue.length || options.signal?.aborted || closed) resolve(); }),
                    child!.registration.close.then(() => { throw new Error('Codex connection closed; the submitted turn was not replayed.'); }),
                    ...(questionTerminalDeadline ? [new Promise<never>((_resolve, reject) => {
                      terminalTimer = setTimeout(() => reject(new Error('Codex question interrupt had no confirmed terminal; no answer was submitted.')),
                        Math.max(1, questionTerminalDeadline! - Date.now()));
                    })] : []),
                  ]);
                } finally { if (terminalTimer) clearTimeout(terminalTimer); }
                wake = undefined;
                options.signal?.throwIfAborted();
                if (closed) throw new Error('Codex conversation closed before completion.');
              }
              const message = queue.shift();
              if (!message) continue;
              queueBytes -= Buffer.byteLength(JSON.stringify(message));
              const method = message.method;
              if (!['turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated', 'error'].includes(method ?? '')) continue;
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
                    if (!endedTurns.has(currentTurnId)) {
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
                  yield { type, item: { id: itemId, type: 'agent_message', text: item.text,
                    ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}),
                  } };
                  if (type === 'item.completed') messageText.delete(itemId);
                } else if (item.type === 'mcpToolCall') {
                  if (item.server !== 'flujo' || typeof item.tool !== 'string' || !['inProgress', 'completed', 'failed'].includes(String(item.status))) throw new Error('Unexpected Codex tool execution.');
                  if (pendingQuestion) throw new Error('Codex continued tool execution while awaiting user input.');
                  if (item.status === 'inProgress') activeTools.add(itemId); else activeTools.delete(itemId);
                  yield { type, item: { ...item, id: itemId, type: 'mcp_tool_call', status: item.status === 'inProgress' ? 'in_progress' : item.status } } as ThreadEvent;
                } else if (!['reasoning', 'userMessage', 'contextCompaction'].includes(String(item.type))) {
                  const itemType = typeof item.type === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(item.type) ? ` (${item.type})` : '';
                  throw new Error(`Codex emitted an unsupported item${itemType}. Update the FLUJO integration before continuing.`);
                }
              } else if (method === 'error') {
                if (params.willRetry !== true) throw new Error('Codex reported a model error; the submitted input was not replayed.');
              } else {
                const turn = record(params.turn);
                activeTurnId = undefined;
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
                  resumedTurnIds.add(currentTurnId);
                  questionController = undefined;
                  awaitingAsyncInput = false;
                  messageText.clear();
                  continue turns;
                }
                if (turn.status === 'completed') {
                  // Usage can be absent; absence must not erase protocol totals or fabricate entitlement.
                  yield { type: 'turn.completed', usage: totalUsage ?? { input_tokens: 0, output_tokens: 0 } } as ThreadEvent;
                } else if (turn.status === 'failed' || turn.status === 'interrupted') {
                  yield { type: 'turn.failed', error: { message: turn.status === 'interrupted' ? 'Codex turn was interrupted.' : 'Codex turn failed.' } };
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
          if (!finished || options.signal?.aborted || activeTurnId) await close();
        }
      })();
      return { events };
    },
  });
}
