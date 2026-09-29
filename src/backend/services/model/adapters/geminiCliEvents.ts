import type OpenAI from 'openai';

export interface GeminiCliStats {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
}
export type GeminiCliEvent =
  | { type: 'init'; session_id: string; model: string }
  | { type: 'message'; role: 'user' | 'assistant'; content: string; delta?: boolean }
  | { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown> }
  | { type: 'tool_result'; tool_id: string; status: 'success' | 'error' }
  | { type: 'error'; severity: 'warning' | 'error'; message: string }
  | { type: 'result'; status: 'success' | 'error'; error?: { message?: string }; stats?: GeminiCliStats };

/** Enforce a bounded record size even when a child never writes a newline. */
export class GeminiCliEventDecoder {
  private pending = '';
  constructor(private readonly onEvent: (event: GeminiCliEvent) => void, private readonly maxRecordBytes = 4 * 1024 * 1024) {}
  push(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      this.record(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
    if (Buffer.byteLength(this.pending) > this.maxRecordBytes) throw new Error('Gemini CLI output record exceeded its limit.');
  }
  finish(): void {
    if (this.pending.trim()) this.record(this.pending);
    this.pending = '';
  }
  private record(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.maxRecordBytes) throw new Error('Gemini CLI output record exceeded its limit.');
    let event: GeminiCliEvent;
    try { event = JSON.parse(line); } catch { throw new Error('Gemini CLI returned malformed stream JSON.'); }
    if (!event || typeof event !== 'object' || !['init', 'message', 'tool_use', 'tool_result', 'error', 'result'].includes(event.type)) {
      throw new Error('Gemini CLI returned an unsupported stream event.');
    }
    if (event.type === 'message' && (typeof event.content !== 'string' || !['user', 'assistant'].includes(event.role))) throw new Error('Gemini CLI returned an invalid message event.');
    if (event.type === 'result' && !['success', 'error'].includes(event.status)) throw new Error('Gemini CLI returned an invalid result event.');
    if (event.type === 'error' && (typeof event.message !== 'string' || !['warning', 'error'].includes(event.severity))) throw new Error('Gemini CLI returned an invalid error event.');
    this.onEvent(event);
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** CLI input_tokens includes cached prompt tokens; input is the uncached subset. */
export function mapGeminiCliUsage(stats: GeminiCliStats | undefined): OpenAI.CompletionUsage {
  const prompt = count(stats?.input_tokens);
  const completion = count(stats?.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: stats?.total_tokens === undefined ? prompt + completion : count(stats.total_tokens),
    prompt_tokens_details: { cached_tokens: Math.min(prompt, count(stats?.cached)) },
  };
}
