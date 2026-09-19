import type { ModelContextUsage } from '@/shared/types/model/contextUsage';
import { mapSdkUsage, type SdkUsage } from './claudeUsage';

const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
type Counts = Record<typeof fields[number], number>;
const empty = (): Counts => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const add = (target: Counts, usage: SdkUsage) => {
  for (const field of fields) target[field] += usage[field] ?? 0;
};
type Step = { usage: SdkUsage; model?: string; hasOutput: boolean; isChild: boolean };
type ModelUsage = {
  inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number; contextWindow?: number; canonicalModel?: string;
};
type UsageMessage = {
  type?: string; uuid?: string; parent_tool_use_id?: string | null;
  message?: { id?: string; model?: string; usage?: SdkUsage };
  event?: { type?: string; message?: { id?: string; model?: string; usage?: SdkUsage }; usage?: SdkUsage };
  usage?: SdkUsage; modelUsage?: Record<string, ModelUsage>;
};

/** Keep per-request context distinct from per-query totals, including repeated SDK frames. */
export class ClaudeUsageTracker {
  private steps = new Map<string, Step>();
  private activeSteps = new Map<string, string>();
  private latestRootStep?: Step;
  private reportedTotals?: Counts;
  private observedAtResult = empty();
  private childrenAtResult = empty();
  private modelUsage: Record<string, ModelUsage> = {};
  private anonymousId = 0;

  observe(rawMessage: unknown): void {
    if (!rawMessage || typeof rawMessage !== 'object') return;
    const message = rawMessage as UsageMessage;
    const parent = message.parent_tool_use_id ?? '';
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start' && event.message?.id) {
        this.activeSteps.set(parent, event.message.id);
        this.update(parent, event.message.id, event.message.usage, event.message.model, false);
      } else if (event?.type === 'message_delta') {
        const id = this.activeSteps.get(parent);
        if (id) this.update(parent, id, event.usage, undefined, true);
      } else if (event?.type === 'message_stop') {
        this.activeSteps.delete(parent);
      }
    } else if (message.type === 'assistant' && message.message?.usage) {
      const assistant = message.message;
      const id = assistant.id ?? this.activeSteps.get(parent) ?? message.uuid ?? `anonymous-${++this.anonymousId}`;
      // Assistant frames repeat the API message_start output placeholder. The
      // real output count comes from message_delta, or the terminal result.
      this.update(parent, id, assistant.usage, assistant.model, false);
    } else if (message.type === 'result') {
      const models = Object.values(message.modelUsage ?? {});
      if (models.length) {
        this.modelUsage = message.modelUsage!;
        this.reportedTotals = empty();
        // modelUsage is cumulative across all user turns within this query,
        // including subagents; never add successive modelUsage snapshots.
        for (const usage of models) add(this.reportedTotals, {
          input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
          cache_creation_input_tokens: usage.cacheCreationInputTokens,
        });
      } else if (message.usage) {
        // Older SDKs expose main-loop totals for just this user turn.
        this.reportedTotals ??= empty();
        add(this.reportedTotals, message.usage);
        const children = this.sumSteps(true);
        for (const field of fields) this.reportedTotals[field] += Math.max(0, children[field] - this.childrenAtResult[field]);
      } else {
        return;
      }
      this.observedAtResult = this.sumSteps();
      this.childrenAtResult = this.sumSteps(true);
    }
  }

  private update(parent: string, id: string, usage: SdkUsage | undefined, model: string | undefined, output: boolean): void {
    if (!usage) return;
    const key = `${parent}\0${id}`;
    let step = this.steps.get(key);
    if (!step) {
      step = { usage: {}, hasOutput: false, isChild: Boolean(parent) };
      this.steps.set(key, step);
      if (!parent) this.latestRootStep = step;
    }
    if (model) step.model = model;
    for (const field of fields) {
      if (field === 'output_tokens' && !output) continue;
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) step.usage[field] = value;
    }
    if (output && usage.output_tokens != null) step.hasOutput = true;
  }

  private sumSteps(childrenOnly = false): Counts {
    const sum = empty();
    for (const step of this.steps.values()) if (!childrenOnly || step.isChild) add(sum, step.usage);
    return sum;
  }

  getUsage(): SdkUsage | undefined {
    if (!this.reportedTotals && !this.steps.size) return undefined;
    const observed = this.sumSteps();
    if (!this.reportedTotals) return observed;
    const totals = { ...this.reportedTotals };
    // A handoff after a previous result may end before the next result arrives.
    for (const field of fields) totals[field] += Math.max(0, observed[field] - this.observedAtResult[field]);
    return totals;
  }

  getContextUsage(configuredWindow?: number): ModelContextUsage | null {
    const step = this.latestRootStep;
    if (!step || step.usage.input_tokens == null) return null;
    const usage = mapSdkUsage(step.usage);
    const models = Object.values(this.modelUsage);
    const runtime = (step.model
      ? this.modelUsage[step.model] ?? models.find(item => item.canonicalModel === step.model)
      : models.length === 1 ? models[0] : undefined)?.contextWindow;
    const runtimeWindow = typeof runtime === 'number' && Number.isFinite(runtime) && runtime > 0 ? runtime : undefined;
    const window = runtimeWindow ?? configuredWindow;
    return {
      promptTokens: usage.promptTokens,
      ...(step.hasOutput ? { completionTokens: usage.completionTokens, totalTokens: usage.totalTokens } : {}),
      ...(typeof window === 'number' && Number.isFinite(window) && window > 0
        ? { contextWindow: window, contextWindowSource: runtimeWindow ? 'runtime' : 'configured' } : {}),
    };
  }
}
