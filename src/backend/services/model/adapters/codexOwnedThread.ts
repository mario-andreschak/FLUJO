import type { ThreadEvent, ThreadOptions, UserInput } from '@openai/codex-sdk';
import { startOwnedCodexAppServer } from './codexAppServerProcess';
import { bundledCodexExecutable } from './codexRestrictedProfile';
import { assertNativeOriginalProcessHost, type NativeOriginalProcessHost } from '@/backend/execution/flow/handlers/nativeOriginalHost';

const unavailable = (): never => { throw new Error('Native Codex Original protocol is held.'); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : unavailable();
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : unavailable();

/** One adapter-owned public app-server, one new thread, one Original turn.
 * No SDK private fields, process monkeypatch, resume, or replacement child. */
export function createOwnedCodexThread(input: {
  host: NativeOriginalProcessHost; env: NodeJS.ProcessEnv; config: Record<string, unknown>;
  options: ThreadOptions; maxTurns: number; executable?: string;
}) {
  assertNativeOriginalProcessHost(input.host);
  let issued = false, closed = false;
  return Object.freeze({
    closureConfirmed: () => closed,
    async runStreamed(prompt: string | UserInput[], options: { signal?: AbortSignal }) {
      if (issued) return unavailable();
      issued = true;
      const entries = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt.map(entry => {
        if (entry.type === 'text') return { type: 'text', text: entry.text };
        if (entry.type === 'local_image') return { type: 'localImage', path: entry.path };
        return unavailable();
      });
      if (!entries.length || entries.length > 128 || Buffer.byteLength(JSON.stringify(entries)) > 8 * 1024 * 1024) return unavailable();
      const events = (async function* (): AsyncGenerator<ThreadEvent> {
        await input.host.assertTurnBudget(input.maxTurns);
        let wake: (() => void) | undefined;
        const notifications: Array<{ method?: string; params?: unknown }> = [];
        let retainedBytes = 0;
        const child = await startOwnedCodexAppServer({
          executable: input.executable ?? bundledCodexExecutable(), args: ['app-server', '--stdio'],
          env: input.env, cwd: input.options.workingDirectory!, owner: input.host, signal: options.signal,
          register: process => input.host.register(process),
          onNotification: message => {
            const bytes = Buffer.byteLength(JSON.stringify(message));
            if (notifications.length >= 256 || retainedBytes + bytes > 8 * 1024 * 1024) return unavailable();
            notifications.push(message); retainedBytes += bytes; wake?.();
          },
        });
        try {
          await input.host.beforeFirstPrompt();
          await child.request('initialize', { clientInfo: { name: 'flujo_native_original', version: '1' } });
          child.notify('initialized');
          await input.host.beforeFirstPrompt();
          const started = record(await child.request('thread/start', {
            model: input.options.model, cwd: input.options.workingDirectory,
            approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, config: input.config,
          }));
          const threadId = id(record(started.thread).id);
          if (started.model !== input.options.model) return unavailable();
          yield { type: 'thread.started', thread_id: threadId };
          await input.host.beforeFirstPrompt();
          const response = record(await child.request('turn/start', { threadId, model: input.options.model,
            effort: input.options.modelReasoningEffort, input: entries }));
          const turnId = id(record(response.turn).id);
          let usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | undefined;
          let terminal = false;
          while (!terminal) {
            options.signal?.throwIfAborted();
            if (!notifications.length) {
              let timer: NodeJS.Timeout | undefined;
              try {
                const live = await Promise.race([
                  new Promise<boolean>(resolve => { wake = () => resolve(true); timer = setTimeout(() => resolve(false), 30000); }),
                  child.registration.close.then(() => false),
                ]);
                if (!live) return unavailable();
              } finally { wake = undefined; if (timer) clearTimeout(timer); }
            }
            const message = notifications.shift();
            if (!message) continue;
            retainedBytes -= Buffer.byteLength(JSON.stringify(message));
            const method = message.method;
            if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method ?? '')) continue;
            const params = record(message.params);
            if (params.threadId !== threadId) return unavailable();
            const messageTurn = method === 'turn/started' || method === 'turn/completed'
              ? record(params.turn).id : params.turnId;
            if (messageTurn !== turnId) return unavailable();
            await input.host.assertOutputCurrent();
            if (method === 'turn/started') yield { type: 'turn.started' };
            else if (method === 'thread/tokenUsage/updated') {
              const total = record(record(params.tokenUsage).total);
              usage = { input_tokens: count(total.inputTokens), output_tokens: count(total.outputTokens),
                cached_input_tokens: count(total.cachedInputTokens) };
            } else if (method === 'item/started' || method === 'item/completed') {
              const item = record(params.item);
              const itemId = id(item.id);
              if (item.type === 'agentMessage') {
                if (typeof item.text !== 'string') return unavailable();
                yield { type: method === 'item/started' ? 'item.started' : 'item.completed',
                  item: { id: itemId, type: 'agent_message', text: item.text } };
              } else if (item.type === 'mcpToolCall') {
                if (!['inProgress', 'completed', 'failed'].includes(String(item.status))) return unavailable();
                yield { type: method === 'item/started' ? 'item.started' : 'item.completed', item: {
                  ...item, id: itemId, type: 'mcp_tool_call', status: item.status === 'inProgress' ? 'in_progress' : item.status,
                } } as ThreadEvent;
              } else if (item.type !== 'reasoning') return unavailable();
            } else {
              terminal = true;
              if (record(params.turn).status !== 'completed' || !usage) return unavailable();
              yield { type: 'turn.completed', usage };
            }
          }
        } finally {
          await child.stop();
          const outcome = await child.registration.exit;
          await child.registration.close;
          closed = true;
          if (outcome.code !== 0 || outcome.signal) return unavailable();
        }
      })();
      return { events };
    },
  });
}
