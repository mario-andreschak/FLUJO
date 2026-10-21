import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { CompletionAdapter, CompletionInput } from '@/backend/services/model/adapters/types';
import type { Model } from '@/shared/types/model';
import type { HarnessRuntimeSnapshot, HarnessToolReplay } from '@/shared/types/harnessIntegration';

export interface HarnessExecutionScope {
  runtime: HarnessRuntimeSnapshot;
  tools: HarnessToolReplay[];
  calls: number;
  replayed: number;
  failed?: string;
  failureKind?: 'tool-evidence' | 'dispatch';
  resourceSnapshots?: Record<string, unknown>;
  resourceReads?: Map<string, Promise<unknown>>;
  kvBoards?: Record<string, import('@/shared/types/kvStore').KvEntry[]>;
  prompts: Array<{ nodeId: string; hash: string; text: string }>;
  trace: Array<{ name: string; arguments: Record<string, unknown>; matched: boolean }>;
  beforeCall: () => Promise<void>;
  afterCall: (tokens: number | null, completedCalls?: number) => Promise<void>;
  authorize: (model: Model) => Promise<void>;
  signal: AbortSignal;
}
const root = globalThis as typeof globalThis & { __flujoHarnessExecution?: AsyncLocalStorage<HarnessExecutionScope> };
const scope = root.__flujoHarnessExecution ??= new AsyncLocalStorage<HarnessExecutionScope>();
export const getHarnessExecution = () => scope.getStore();
export const withHarnessExecution = <T>(value: HarnessExecutionScope, task: () => Promise<T>) => scope.run(value, task);
export const canonicalHarnessJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalHarnessJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalHarnessJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
export const harnessDigest = (value: unknown) => createHash('sha256').update(canonicalHarnessJson(value)).digest('hex');

/** Only server-owned ALS can enter replay. No serialized request flag grants it. */
export function replayHarnessTool(name: string, args: Record<string, unknown>): string {
  const current = getHarnessExecution();
  if (!current) throw new Error('Harness replay is not active.');
  current.signal.throwIfAborted();
  const index = current.tools.findIndex(item => item.name === name
    && canonicalHarnessJson(item.arguments) === canonicalHarnessJson(args));
  current.trace.push({ name, arguments: args, matched: index >= 0 });
  if (index < 0) {
    current.failed = `No recorded result for tool ${name}. External execution was refused.`;
    current.failureKind = 'tool-evidence';
    throw new Error(current.failed);
  }
  current.replayed++;
  const recorded = current.tools.splice(index, 1)[0];
  if (recorded.recordingId) current.tools = current.tools.filter(item => item.recordingId !== recorded.recordingId);
  return recorded.output;
}

/** Resource reads use the real resolver once, then an identical response across variants. */
export async function harnessResourceSnapshot<T>(key: string, read: () => Promise<T>): Promise<T> {
  const current = getHarnessExecution();
  if (!current) return read();
  const cache = current.resourceSnapshots ??= {};
  if (Object.hasOwn(cache, key)) return structuredClone(cache[key]) as T;
  const pending = current.resourceReads ??= new Map();
  if (!pending.has(key)) pending.set(key, (async () => {
    const result = await read();
    if (JSON.stringify(cache).length + (JSON.stringify(result) ?? 'null').length > 2_000_000) {
      current.failed = 'Evaluation resource evidence exceeded its limit.';
      throw new Error(current.failed);
    }
    cache[key] = result;
    return result;
  })());
  return structuredClone(await pending.get(key)) as T;
}

export function guardHarnessAdapter(adapter: CompletionAdapter): CompletionAdapter {
  const current = getHarnessExecution();
  if (!current) return adapter;
  const complete = async (input: CompletionInput) => {
    try {
      current.signal.throwIfAborted();
      if (current.failed || ++current.calls > current.runtime.maxModelCallsPerProbe) {
        current.failed ??= 'The evaluation model-call limit was reached.';
        throw new Error(current.failed);
      }
      await current.authorize(input.model);
      if (input.model.provider === 'codex' && input.apiKey) throw new Error('Codex evaluation requires subscription authentication.');
      await current.beforeCall();
      let dispatched = 1;
      let outputChars = 0;
      const text = input.messages.filter(message => message.role === 'system' || message.role === 'developer')
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n\n');
      current.prompts.push({ nodeId: input.nodeId ?? 'model', hash: harnessDigest(text), text });
      const localToolExecutors = { ...input.localToolExecutors };
      const names = new Set([...Object.keys(localToolExecutors), ...(input.tools ?? []).map(tool => tool.function.name)]);
      for (const name of names) {
        if (!name.startsWith('handoff_to_') && name !== 'handoff') {
          localToolExecutors[name] = args => withHarnessExecution(current, async () => replayHarnessTool(name, args));
        }
      }
      // Keep the engine's assembled messages, model settings and tool definitions.
      // Every side-effecting executor is replaced at the actual dispatch boundary.
      const result = await adapter.createCompletion({ ...input,
        maxTurns: Math.min(input.maxTurns ?? current.runtime.maxModelCallsPerProbe, current.runtime.maxModelCallsPerProbe - current.calls + 1),
        signal: current.signal, localToolExecutors, nativeToolPort: undefined, nativeOriginalProcessHost: undefined,
        codexSession: undefined, sessionResume: false, responsesSession: undefined,
        requestToolApproval: undefined, steering: undefined, consumeSteeringMessages: undefined,
        beforeModelDispatch: async () => {
          if (current.failed) throw new Error(current.failed);
          if (++current.calls > current.runtime.maxModelCallsPerProbe) throw new Error('The evaluation model-call limit was reached.');
          await current.authorize(input.model);
          await input.beforeModelDispatch?.();
          await current.beforeCall();
          dispatched++;
        },
        onModelDelta: delta => {
          outputChars += (delta.contentDelta?.length ?? 0) + (delta.toolCallDelta?.argumentsDelta?.length ?? 0);
          if (outputChars > 64000) throw new Error('The evaluation response exceeded its limit.');
          input.onModelDelta?.(delta);
        },
      });
      await current.afterCall(result.completion.usage?.total_tokens ?? null, dispatched);
      const content = result.completion.choices[0]?.message?.content;
      if ((typeof content === 'string' && content.length > 32000) || result.completion.choices[0]?.finish_reason === 'length'
        || JSON.stringify(result.transcript ?? []).length > 256000) throw new Error('The evaluation response exceeded its limit.');
      if (result.completion.model.replace(/:free$/, '') !== input.model.name.replace(/:free$/, '')) {
        current.failed = 'The evaluation provider changed model identity.';
        throw new Error(current.failed);
      }
      return result;
    } catch (error) {
      // An outer engine retry must never issue a second physical request after an uncertain result.
      current.failed ??= 'The evaluation dispatch failed or its context changed.';
      current.failureKind ??= 'dispatch';
      throw error;
    }
  };
  return { createCompletion: complete, createStreamCompletion: complete };
}
