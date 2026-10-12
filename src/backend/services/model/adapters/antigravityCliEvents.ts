import type OpenAI from 'openai';

export interface AntigravityCliStats {
  total_tokens?: number; input_tokens?: number; output_tokens?: number;
  thinking_tokens?: number; cache_read_tokens?: number;
}
export type AntigravityCliEvent =
  | { event: 'init'; conversation_id: string; init: { cwd: string; tools: string[]; permission_mode: string; agent?: string; model?: string } }
  | { event: 'step_update'; step_update: { conversation_id: string; step_index: number; state: string; step_type: string; text_delta?: string; tool_name?: string; tool_info?: { name?: string; parameters?: Record<string, unknown> }; usage?: AntigravityCliStats } }
  | { event: 'result'; result: { conversation_id: string; status: 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED' | 'INVALID' | 'WAITING' | 'RUNNING'; response: string; error?: string; num_turns?: number; usage?: AntigravityCliStats } };

export class AntigravityCliEventDecoder {
  private pending = '';
  constructor(private readonly onEvent: (event: AntigravityCliEvent) => void, private readonly maxRecordBytes = 4 * 1024 * 1024) {}
  push(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      this.record(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
    if (Buffer.byteLength(this.pending) > this.maxRecordBytes) throw new Error('Antigravity CLI output record exceeded its limit.');
  }
  finish(): void {
    if (this.pending.trim()) this.record(this.pending);
    this.pending = '';
  }
  private record(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.maxRecordBytes) throw new Error('Antigravity CLI output record exceeded its limit.');
    let event: AntigravityCliEvent;
    try { event = JSON.parse(line); } catch { throw new Error('Antigravity CLI returned malformed stream JSON.'); }
    if (!event || typeof event !== 'object') throw new Error('Antigravity CLI returned an unsupported stream event.');
    if (event.event === 'init') {
      if (typeof event.conversation_id !== 'string' || !event.init || !Array.isArray(event.init.tools)
        || !event.init.tools.every(tool => typeof tool === 'string') || typeof event.init.cwd !== 'string'
        || typeof event.init.permission_mode !== 'string') throw new Error('Antigravity CLI returned an invalid init event.');
    } else if (event.event === 'step_update') {
      const step = event.step_update;
      if (!step || typeof step.conversation_id !== 'string' || !Number.isSafeInteger(step.step_index) || step.step_index < 0
        || typeof step.state !== 'string' || typeof step.step_type !== 'string'
        || (step.text_delta !== undefined && typeof step.text_delta !== 'string')) throw new Error('Antigravity CLI returned an invalid step event.');
    } else if (event.event === 'result') {
      const result = event.result;
      if (!result || typeof result.conversation_id !== 'string' || typeof result.response !== 'string'
        || !['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'].includes(result.status)) throw new Error('Antigravity CLI returned an invalid result event.');
    } else throw new Error('Antigravity CLI returned an unsupported stream event.');
    this.onEvent(event);
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Antigravity excludes cached input and includes thinking in its output counter. */
export function mapAntigravityCliUsage(stats: AntigravityCliStats | undefined): OpenAI.CompletionUsage {
  const cached = count(stats?.cache_read_tokens);
  const prompt = count(stats?.input_tokens) + cached;
  const completion = count(stats?.output_tokens);
  return {
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: Math.min(completion, count(stats?.thinking_tokens)) },
  };
}
