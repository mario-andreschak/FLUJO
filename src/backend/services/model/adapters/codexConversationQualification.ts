import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createCodexAppServerThread } from './codexAppServerThread';
import type { CodexUsageLike } from './codexUsage';

const MODEL = 'flujo-qualification-model';
const REPLY = 'FLUJO qualification reply.';
const INPUT_TOKENS = 120, OUTPUT_TOKENS = 18;

/** A one-reply stand-in for the Responses API on 127.0.0.1. */
function standInModelService() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Read the whole request before answering. */ }
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}');
      return;
    }
    calls++;
    const item = { type: 'message', id: `msg_qualification_${calls}`, status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: REPLY, annotations: [] }] };
    const done = { id: `resp_qualification_${calls}`, object: 'response', status: 'completed', created_at: 1700000000, model: MODEL,
      output: [item], usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS, total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const events = [
      { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: REPLY },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: done },
    ];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      .end(events.map((event, index) => `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''));
  });
  return { server, calls: () => calls };
}

/**
 * Run one real conversation turn on a candidate Codex and read it with FLUJO's
 * own conversation code, so an update whose messages FLUJO cannot read is never
 * used. The model is a local stand-in: no login, account or network. Only the
 * isolated update environment is passed on.
 */
export async function qualifyCodexConversation(input: {
  executable: string; home: string; signal: AbortSignal; environment(home: string): NodeJS.ProcessEnv;
}): Promise<void> {
  const service = standInModelService();
  await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
  const probeHome = await fs.mkdtemp(path.join(input.home, 'conversation-probe-'));
  try {
    const keyName = 'FLUJO_QUALIFICATION_KEY';
    await fs.writeFile(path.join(probeHome, 'config.toml'), [
      'model_provider = "flujo_qualification"', `model = "${MODEL}"`, 'cli_auth_credentials_store = "file"',
      '[model_providers.flujo_qualification]', 'name = "FLUJO qualification"',
      `base_url = "http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1"`,
      `env_key = "${keyName}"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n'), { mode: 0o600 });
    let usage: CodexUsageLike | undefined, text: string | undefined, completed = false;
    const thread = createCodexAppServerThread({
      executable: input.executable, env: { ...input.environment(probeHome), [keyName]: randomBytes(12).toString('hex') },
      config: { features: { shell_tool: false } }, options: { model: MODEL, workingDirectory: probeHome },
      developerInstructions: 'FLUJO runtime qualification.', maxTurns: 1,
      onUsage: total => { usage = total; },
    });
    try {
      const { events } = await thread.runStreamed('Reply with the qualification text.', { signal: input.signal });
      for await (const event of events) {
        if (event.type === 'item.completed' && event.item.type === 'agent_message') text = event.item.text;
        else if (event.type === 'turn.completed') completed = true;
        else if (event.type === 'turn.failed') throw new Error('Codex qualification turn failed');
      }
    } finally { await thread.close(); }
    if (!completed || text !== REPLY || service.calls() !== 1
      || usage?.input_tokens !== INPUT_TOKENS || usage.output_tokens !== OUTPUT_TOKENS) {
      throw new Error('Codex conversation protocol changed');
    }
  } finally {
    service.server.close();
    // Codex can hold its session files for a moment after exit on Windows.
    await fs.rm(probeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
