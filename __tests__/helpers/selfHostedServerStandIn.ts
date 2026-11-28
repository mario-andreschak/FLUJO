/**
 * A local stand-in for the self-hosted OpenAI-compatible servers of issue #1367:
 * vLLM, llama.cpp (`llama-server --jinja`), LM Studio and Ollama, all serving a
 * Qwen 3.5 model. No model runs and no GPU is needed: each answer comes from a
 * script. Everything around the answer follows each server's public source or
 * its own documentation and bug reports (checked November 2026):
 *
 * Chat template (vLLM, llama.cpp and LM Studio run the model's own Jinja file)
 *  - Qwen 3.5 `chat_template.jinja` as shipped in llama.cpp
 *    `models/templates/Qwen3.5-4B.jinja`: "System message must be at the
 *    beginning." for any system message that is not the very first,
 *    "No user query found in messages." when no user turn (other than a
 *    `<tool_response>` wrapper) exists, "Unexpected message role.",
 *    "Unexpected content type.", "Unexpected item type in content." and
 *    "System message cannot contain images.". Tool call arguments are read
 *    with `|items`, so they must be a JSON object.
 *  - vLLM `renderers/chat_utils/chat_message.py` `_postprocess_messages`
 *    parses those arguments with `json.loads`; vLLM 0.11 let the decode error
 *    fail the request, today's vLLM uses `{}` instead.
 *  - Ollama renders Qwen in Go (`model/renderers/qwen35.go`): later system
 *    messages are folded into the first one (Qwen 3.8) instead of refused,
 *    and "no user query found in messages" is still an error. A render error
 *    is answered with HTTP 500 (`server/routes.go`).
 *
 * Errors, in each server's own shape
 *  - vLLM `serve/exception_handling/error_response.py`: 400
 *    `{"error":{"message","type":"BadRequestError","param":null,"code":400}}`.
 *  - llama.cpp `server.cpp` `ex_wrapper` and `format_error_response`, message
 *    as in anomalyco/opencode#17638: 400 `{"error":{"code":400,"message":
 *    "... Jinja Exception: <reason>","type":"invalid_request_error"}}`.
 *  - LM Studio, lmstudio-bug-tracker#2012: 400 whose `error` is a plain
 *    string, "Error rendering prompt with jinja template: \"<reason>\". ...".
 *  - Ollama `openai/openai.go` `NewError`: `{"error":{"message","type",
 *    "param":null,"code":null}}`, `invalid_request_error` for 400,
 *    `api_error` otherwise.
 *
 * Token counts
 *  - vLLM `serve/utils/api_utils.py` `should_include_usage`: a streamed reply
 *    carries counts only when `stream_options.include_usage` is set, in a last
 *    chunk with `choices: []`. Its request model refuses `stream_options`
 *    without `stream: true` ("Stream options can only be defined when
 *    `stream=True`."). Replies without streaming always carry `usage`.
 *  - llama.cpp `server-task.cpp` `to_json_oaicompat_chat(_stream)` and
 *    PR #16052: counts in a last `choices: []` chunk only when asked for; its
 *    own `timings` (`prompt_n`, `cache_n`, `predicted_n`) on the last chunk
 *    always.
 *  - LM Studio changelog 0.3.18: `stream_options.include_usage` returns the
 *    counts while streaming; nothing otherwise.
 *  - Ollama `middleware/openai.go` `ChatWriter`: a finish chunk, then a
 *    `choices: []` chunk with `usage` and `timings` only when asked for.
 *
 * Finish reasons and tool calls cut off by the output limit
 *  - vLLM `serve/utils/tool_calls_utils.py` `resolve_finish_reason`: today a
 *    cut keeps `length`. Before PR #46303 (September 2026, streaming) and
 *    PR #59324 (October 2026, without streaming) vLLM reported `tool_calls`
 *    for a call cut off mid-arguments, after completing the cut JSON itself
 *    (`_should_check_for_unstreamed_tool_arg_tokens`). The `vllm-0.11` kind
 *    keeps that older behaviour, which servers in use still have. A call
 *    whose JSON cannot be parsed comes back as raw text without streaming.
 *  - llama.cpp: `tool_calls` only when generation stopped on its own,
 *    `length` otherwise; arguments are streamed as they are written.
 *  - LM Studio changelog 0.3.15 / 0.3.17: `tool_calls` "when appropriate",
 *    argument tokens streamed as they are generated.
 *  - Ollama `FinishChunk`: `tool_calls` only overrides `stop`; its parser
 *    sends a tool call whole, so a cut-off call is never sent at all.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SelfHostedServerKind = 'vllm' | 'vllm-0.11' | 'llama.cpp' | 'lm-studio' | 'ollama';

export const SELF_HOSTED_SERVER_KINDS: readonly SelfHostedServerKind[] = ['vllm', 'vllm-0.11', 'llama.cpp', 'lm-studio', 'ollama'];

export const STAND_IN_MODEL = 'Qwen/Qwen3.5-35B-A3B';

type WireMessage = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };

export interface StandInRequest {
  model?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean } | null;
  max_tokens?: number;
  messages?: WireMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

/**
 * What the scripted model does with one request. `call` names a tool, or the
 * start of one (`handoff_to_`). FLUJO's own requests for a compaction summary
 * are answered with a summary in the five sections it asks for, as JSON when
 * the request asks for that, without using up the script.
 */
export type ScriptedTurn =
  | { say: string }
  | { call: string; args?: Record<string, unknown>; say?: string }
  | { cutOffCall: string; args: Record<string, unknown>; say?: string };

const SUMMARY = ['## Objective', 'Finish the tasks.', '## Important Details', 'None.', '## Work State', 'Earlier tasks answered.',
  '## Next Move', 'Answer the final task.', '## Relevant Files', 'None.'].join('\n');

export interface RecordedRequest {
  body: StandInRequest;
  status: number;
  /** The reason a refused request was refused, in the server's words. */
  refusal?: string;
}

class StandInRefusal extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
      ? (item as { text: string }).text : '')).join(' ');
  }
  return '';
}

/** `render_content` of the Qwen 3.5 template. */
function checkQwenContent(content: unknown, isSystem: boolean): void {
  if (typeof content === 'string' || content === null || content === undefined) return;
  if (!Array.isArray(content)) throw new StandInRefusal(400, 'Unexpected content type.');
  for (const item of content) {
    const part = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if ('image' in part || 'image_url' in part || part.type === 'image') {
      if (isSystem) throw new StandInRefusal(400, 'System message cannot contain images.');
    } else if ('video' in part || part.type === 'video') {
      if (isSystem) throw new StandInRefusal(400, 'System message cannot contain videos.');
    } else if (!('text' in part)) {
      throw new StandInRefusal(400, 'Unexpected item type in content.');
    }
  }
}

const isUserQuery = (message: WireMessage) => {
  const text = contentText(message.content).trim();
  return message.role === 'user' && !(text.startsWith('<tool_response>') && text.endsWith('</tool_response>'));
};

/** The Qwen 3.5 Jinja template, in the order it raises its errors. */
export function qwen35TemplateRefusal(messages: WireMessage[]): string | undefined {
  try {
    if (messages.length === 0) throw new StandInRefusal(400, 'No messages provided.');
    if (messages[0].role === 'system') checkQwenContent(messages[0].content, true);
    for (const message of [...messages].reverse()) {
      if (message.role === 'user') checkQwenContent(message.content, false);
    }
    if (!messages.some(isUserQuery)) throw new StandInRefusal(400, 'No user query found in messages.');
    messages.forEach((message, index) => {
      checkQwenContent(message.content, false);
      if (message.role === 'system') {
        if (index !== 0) throw new StandInRefusal(400, 'System message must be at the beginning.');
      } else if (!['user', 'assistant', 'tool'].includes(String(message.role))) {
        throw new StandInRefusal(400, 'Unexpected message role.');
      }
    });
    return undefined;
  } catch (error) {
    if (error instanceof StandInRefusal) return error.reason;
    throw error;
  }
}

/** vLLM turns each tool call's JSON `arguments` into a mapping before the template runs. */
function checkToolCallArguments(messages: WireMessage[], strict: boolean): void {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as Array<{ function?: { arguments?: unknown } }>) {
      const args = call?.function?.arguments;
      if (typeof args !== 'string' || !args) continue;
      try {
        JSON.parse(args);
      } catch (error) {
        if (strict) throw new StandInRefusal(400, (error as Error).message);
      }
    }
  }
}

/** Ollama's Qwen renderer: every system message becomes part of one leading system turn. */
function ollamaRendererRefusal(messages: WireMessage[]): string | undefined {
  if (messages.length === 0) return 'no messages provided';
  if (!messages.some(isUserQuery)) return 'no user query found in messages';
  return undefined;
}

/** Close a cut-off JSON object the way a partial-JSON parser completes it. */
function closePartialJson(prefix: string): string {
  let inString = false;
  let escaped = false;
  const open: string[] = [];
  for (const char of prefix) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') open.push('}');
    else if (char === '[') open.push(']');
    else if (char === '}' || char === ']') open.pop();
  }
  return (inString ? '"' : '') + open.reverse().join('');
}

function halves(text: string): string[] {
  if (text.length < 2) return text ? [text] : [];
  const middle = Math.ceil(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

interface PlannedReply {
  text: string;
  call?: { id: string; name: string; arguments: string; cut: boolean };
  finishReason: 'stop' | 'length' | 'tool_calls';
  promptTokens: number;
  completionTokens: number;
}

export interface StandInOptions {
  /** The context length the server was started with (vLLM `--max-model-len`, llama.cpp `-c`). */
  maxModelLen?: number;
}

export class SelfHostedServerStandIn {
  readonly requests: RecordedRequest[] = [];
  script: ScriptedTurn[] = [];
  /**
   * A template error every request meets until it is cleared, such as a
   * Jinja feature the server's engine lacks (LM Studio's "Unknown test:
   * sequence", lmstudio-bug-tracker#2233). FLUJO cannot reorder its way out.
   */
  templateError?: string;
  baseUrl = '';
  readonly maxModelLen: number;
  /** Compaction summaries written since the last reset. */
  summaries = 0;
  private server?: Server;
  private replies = 0;

  private constructor(readonly kind: SelfHostedServerKind, options: StandInOptions) {
    this.maxModelLen = options.maxModelLen ?? 32_768;
  }

  static async start(kind: SelfHostedServerKind, options: StandInOptions = {}): Promise<SelfHostedServerStandIn> {
    const standIn = new SelfHostedServerStandIn(kind, options);
    standIn.server = createServer((request, response) => standIn.handle(request, response));
    await new Promise<void>(resolve => standIn.server!.listen(0, '127.0.0.1', resolve));
    standIn.baseUrl = `http://127.0.0.1:${(standIn.server.address() as AddressInfo).port}/v1`;
    return standIn;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  /** Requests the server answered with a reply. */
  get answered(): StandInRequest[] {
    return this.requests.filter(request => request.status === 200).map(request => request.body);
  }

  get refusals(): string[] {
    return this.requests.flatMap(request => request.refusal ? [request.refusal] : []);
  }

  reset(): void {
    this.requests.length = 0;
    this.script = [];
    this.templateError = undefined;
    this.replies = 0;
    this.summaries = 0;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      let body: StandInRequest = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StandInRequest;
        if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
          throw new StandInRefusal(404, `Unexpected endpoint or method. (${request.method} ${request.url})`);
        }
        this.validate(body);
        const reply = this.plan(body);
        this.requests.push({ body, status: 200 });
        if (body.stream) this.stream(body, reply, response);
        else this.complete(reply, response);
      } catch (error) {
        if (!(error instanceof StandInRefusal)) throw error;
        this.requests.push({ body, status: error.status, refusal: error.reason });
        this.refuse(error, response);
      }
    });
  }

  private validate(body: StandInRequest): void {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (this.kind === 'vllm' || this.kind === 'vllm-0.11') {
      if (body.stream_options && !body.stream) {
        throw new StandInRefusal(400, 'Stream options can only be defined when `stream=True`.');
      }
      checkToolCallArguments(messages, this.kind === 'vllm-0.11');
    }
    const refusal = (this.kind === 'ollama' ? ollamaRendererRefusal(messages) : qwen35TemplateRefusal(messages)) ?? this.templateError;
    if (refusal) throw new StandInRefusal(this.kind === 'ollama' ? 500 : 400, refusal);
  }

  private refuse(error: StandInRefusal, response: ServerResponse): void {
    const reason = error.reason;
    const body = (() => {
      switch (this.kind) {
        case 'vllm':
        case 'vllm-0.11':
          return { error: { message: reason, type: error.status === 404 ? 'NotFoundError' : 'BadRequestError', param: null, code: error.status } };
        case 'llama.cpp':
          return { error: { code: error.status, message: `Unable to generate parser for this template. Automatic parser generation failed: \n------------\nError: Jinja Exception: ${reason}`, type: 'invalid_request_error' } };
        case 'lm-studio':
          return { error: `Error rendering prompt with jinja template: "${reason}".\n\nThis is usually an issue with the model's prompt template. If you are using a popular model, you can try to search the model under lmstudio-community, which will have fixed prompt templates. If you cannot find one, you are welcome to post this issue to our discord or issue tracker on GitHub. Alternatively, if you know how to write jinja templates, you can override the prompt template in My Models > model settings > Prompt Template.` };
        case 'ollama':
          return { error: { message: reason, type: error.status === 400 ? 'invalid_request_error' : 'api_error', param: null, code: null } };
      }
    })();
    response.writeHead(error.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private toolCallId(): string {
    switch (this.kind) {
      case 'vllm':
      case 'vllm-0.11':
        return `chatcmpl-tool-${randomBytes(16).toString('hex')}`;
      case 'llama.cpp':
        return randomBytes(16).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 32);
      case 'lm-studio':
        return String(100_000_000 + randomBytes(3).readUIntBE(0, 3));
      case 'ollama':
        return `call_${randomBytes(4).toString('hex')}`;
    }
  }

  private plan(body: StandInRequest): PlannedReply {
    const messages = body.messages ?? [];
    const promptTokens = words(messages.map(message => `${String(message.role)} ${contentText(message.content)}`).join('\n'))
      + words((body.tools ?? []).map(tool => tool.function?.name ?? '').join(' '));
    // vLLM and llama.cpp let a reply run to the end of the context when no cap is sent.
    const cap = typeof body.max_tokens === 'number' ? body.max_tokens : Math.max(1, this.maxModelLen - promptTokens);
    if (messages.some(message => contentText(message.content).includes('This message is a compaction control'))) {
      this.summaries++;
      const asJson = messages.some(message => contentText(message.content).includes('return ONLY a JSON object'));
      const text = asJson ? JSON.stringify({ summary: SUMMARY, protectedUserIds: [] }) : SUMMARY;
      return { text, finishReason: 'stop', promptTokens, completionTokens: Math.min(cap, words(text) + 1) };
    }
    const turn = this.script.shift() ?? { say: `answer ${++this.replies}` };
    const offered = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    const toolNamed = (wanted: string) => offered.find(tool => tool === wanted) ?? offered.find(tool => tool.startsWith(wanted)) ?? wanted;
    if ('call' in turn) {
      const text = turn.say ?? '';
      const fullArguments = JSON.stringify(turn.args ?? {});
      return {
        text, call: { id: this.toolCallId(), name: toolNamed(turn.call), arguments: fullArguments, cut: false }, finishReason: 'tool_calls',
        promptTokens, completionTokens: Math.min(cap, words(text) + words(fullArguments) + 3),
      };
    }
    if ('cutOffCall' in turn) {
      // The output limit ends the reply inside the call's arguments.
      const fullArguments = JSON.stringify(turn.args);
      return {
        text: turn.say ?? '',
        call: { id: this.toolCallId(), name: toolNamed(turn.cutOffCall), arguments: fullArguments.slice(0, Math.max(2, Math.floor(fullArguments.length / 2))), cut: true },
        finishReason: 'length', promptTokens, completionTokens: cap,
      };
    }
    return { text: turn.say, finishReason: 'stop', promptTokens, completionTokens: Math.min(cap, words(turn.say) + 1) };
  }

  private usage(reply: PlannedReply) {
    const total = reply.promptTokens + reply.completionTokens;
    switch (this.kind) {
      case 'vllm':
      case 'vllm-0.11':
        return { prompt_tokens: reply.promptTokens, total_tokens: total, completion_tokens: reply.completionTokens, prompt_tokens_details: null };
      case 'llama.cpp':
        return { completion_tokens: reply.completionTokens, prompt_tokens: reply.promptTokens, total_tokens: total, prompt_tokens_details: { cached_tokens: 0 } };
      case 'lm-studio':
      case 'ollama':
        return { prompt_tokens: reply.promptTokens, completion_tokens: reply.completionTokens, total_tokens: total };
    }
  }

  private llamaCppTimings(reply: PlannedReply) {
    return { cache_n: 0, prompt_n: reply.promptTokens, prompt_ms: 12.5, prompt_per_token_ms: 0.4, prompt_per_second: 2500,
      predicted_n: reply.completionTokens, predicted_ms: 40, predicted_per_token_ms: 8, predicted_per_second: 125 };
  }

  /** The raw text a model writes for a call, which a server returns when its parser cannot read the call. */
  private rawCallText(reply: PlannedReply): string {
    const call = reply.call!;
    return `${reply.text ? `${reply.text}\n\n` : ''}<tool_call>\n{"name": "${call.name}", "arguments": ${call.arguments}`;
  }

  private complete(reply: PlannedReply, response: ServerResponse): void {
    const vllm = this.kind.startsWith('vllm');
    let content: string | null = reply.text || null;
    let toolCalls: unknown[] | undefined;
    if (reply.call && !reply.call.cut) {
      toolCalls = [{ id: reply.call.id, type: 'function', function: { name: reply.call.name, arguments: reply.call.arguments } }];
    } else if (reply.call?.cut && this.kind !== 'ollama') {
      // The cut JSON cannot be parsed, so the server hands back the raw text (Ollama's parser keeps it back).
      content = this.rawCallText(reply);
    }
    const message = { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : vllm ? { tool_calls: [] } : {}) };
    const body: Record<string, unknown> = {
      id: this.completionId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: STAND_IN_MODEL,
      choices: [{ index: 0, message, logprobs: null, finish_reason: reply.finishReason, ...(vllm ? { stop_reason: null } : {}) }],
      usage: this.usage(reply),
    };
    if (this.kind === 'llama.cpp') Object.assign(body, { system_fingerprint: 'b7240-3f4c2a1', timings: this.llamaCppTimings(reply) });
    if (this.kind === 'lm-studio') Object.assign(body, { stats: {}, system_fingerprint: STAND_IN_MODEL });
    if (this.kind === 'ollama') Object.assign(body, { system_fingerprint: 'fp_ollama' });
    if (vllm) Object.assign(body, { prompt_logprobs: null, kv_transfer_params: null });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private completionId(): string {
    return this.kind === 'ollama' ? `chatcmpl-${randomBytes(2).readUInt16BE(0)}` : `chatcmpl-${randomBytes(12).toString('hex')}`;
  }

  private stream(body: StandInRequest, reply: PlannedReply, response: ServerResponse): void {
    const includeUsage = Boolean(body.stream_options?.include_usage);
    const id = this.completionId();
    const created = Math.floor(Date.now() / 1000);
    const envelope = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
      id, object: 'chat.completion.chunk', created, model: STAND_IN_MODEL,
      ...(this.kind === 'llama.cpp' ? { system_fingerprint: 'b7240-3f4c2a1' } : {}),
      ...(this.kind === 'ollama' ? { system_fingerprint: 'fp_ollama' } : {}),
      ...(this.kind === 'lm-studio' ? { system_fingerprint: STAND_IN_MODEL } : {}),
      choices, ...extra,
    });
    const choice = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
      index: 0, delta, ...(this.kind === 'llama.cpp' || this.kind === 'ollama' ? {} : { logprobs: null }), finish_reason: finishReason,
      ...(finishReason && this.kind.startsWith('vllm') ? { stop_reason: null } : {}),
    });
    const chunks: unknown[] = [];
    const call = reply.call;

    // Opening chunk with the role.
    if (this.kind === 'llama.cpp') chunks.push(envelope([choice({ role: 'assistant', content: null })]));
    else if (this.kind.startsWith('vllm')) chunks.push(envelope([choice({ role: 'assistant', content: '' })]));
    const textPieces = halves(reply.text);
    textPieces.forEach((piece, index) => chunks.push(envelope([choice({
      ...(index === 0 && (this.kind === 'ollama' || this.kind === 'lm-studio') ? { role: 'assistant' } : {}), content: piece,
    })])));
    if (textPieces.length === 0 && (this.kind === 'ollama' || this.kind === 'lm-studio')) {
      chunks.push(envelope([choice({ role: 'assistant', content: '' })]));
    }

    let finishReason: string = reply.finishReason;
    if (call && this.kind === 'ollama') {
      // Ollama sends a call only once its parser has read all of it.
      if (!call.cut) {
        chunks.push(envelope([choice({ content: '', tool_calls: [{ id: call.id, index: 0, type: 'function', function: { name: call.name, arguments: call.arguments } }] })]));
      }
    } else if (call) {
      chunks.push(envelope([choice({ tool_calls: [{
        index: 0, id: call.id, type: 'function',
        function: this.kind.startsWith('vllm') ? { name: call.name } : { name: call.name, arguments: '' },
      }] })]));
      for (const piece of halves(call.arguments)) {
        chunks.push(envelope([choice({ tool_calls: [{ index: 0, function: { arguments: piece } }] })]));
      }
      if (call.cut && this.kind === 'vllm-0.11') {
        // vLLM before #46303 completed the cut JSON and reported tool_calls.
        chunks.push(envelope([choice({ tool_calls: [{ index: 0, function: { arguments: closePartialJson(call.arguments) } }] })]));
        finishReason = 'tool_calls';
      }
    }

    const usage = this.usage(reply);
    if (this.kind === 'llama.cpp') {
      chunks.push(envelope([choice({}, finishReason)]));
      if (includeUsage) chunks.push(envelope([], { usage }));
      Object.assign(chunks.at(-1) as Record<string, unknown>, { timings: this.llamaCppTimings(reply) });
    } else if (this.kind === 'ollama') {
      chunks.push(envelope([choice({}, finishReason)]));
      if (includeUsage) chunks.push(envelope([], { usage, timings: { prompt_n: reply.promptTokens, predicted_n: reply.completionTokens } }));
    } else {
      chunks.push(envelope([choice(this.kind.startsWith('vllm') ? { content: '' } : {}, finishReason)]));
      if (includeUsage) chunks.push(envelope([], { usage }));
    }

    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end('data: [DONE]\n\n');
  }
}
