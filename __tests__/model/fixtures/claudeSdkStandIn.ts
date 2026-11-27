/**
 * Runs FLUJO's Claude subscription adapter against the installed Agent SDK
 * with its bundled Claude Code (in their own processes, as Jest cannot load
 * the SDK's ESM build) and a stand-in model service on this machine.
 *
 * `relayQuery` is the SDK's `query()` as the adapter sees it: the bridge
 * process runs the real Claude Code, its frames stream back as they arrive and
 * every callback (hooks, permission check, tool handlers) is answered by the
 * adapter's own. Claude Code sends its model requests to the stand-in, which
 * answers each one with the blocks a test scripts for it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';

export type StandInBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> };

/** What the stand-in model answers to its n-th request (0-based). */
export type StandInScript = (request: number) => StandInBlock[];

export interface ClaudeModelStandIn {
  baseUrl: string;
  /** Each model request's messages, as JSON. Counted as soon as Claude Code sends it. */
  requests: string[];
  /** The tool names each model request offered the model. */
  offeredTools: string[][];
  script: StandInScript;
  close(): Promise<void>;
}

/** A stand-in for the model service, answering Claude Code's streamed `/v1/messages` requests. */
export async function startClaudeModelStandIn(outputTokens: number): Promise<ClaudeModelStandIn> {
  const standIn: ClaudeModelStandIn = {
    baseUrl: '',
    requests: [],
    offeredTools: [],
    script: () => [],
    close: async () => undefined,
  };
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      request.resume();
      response.writeHead(404).end('{}');
      return;
    }
    const index = standIn.requests.length;
    standIn.requests.push('');
    standIn.offeredTools[index] = [];
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const sent = JSON.parse(body) as { model: string; messages: unknown[]; tools?: Array<{ name?: string }> };
      standIn.requests[index] = JSON.stringify(sent.messages);
      standIn.offeredTools[index] = (sent.tools ?? []).map(tool => String(tool.name));
      const blocks = standIn.script(index);
      const events: Array<[string, unknown]> = [
        ['message_start', { type: 'message_start', message: { id: `msg_${index + 1}`, type: 'message', role: 'assistant',
          model: sent.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ];
      blocks.forEach((block, position) => {
        if (block.type === 'text') {
          events.push(['content_block_start', { type: 'content_block_start', index: position, content_block: { type: 'text', text: '' } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: position, delta: { type: 'text_delta', text: block.text } }]);
        } else if (block.type === 'thinking') {
          events.push(['content_block_start', { type: 'content_block_start', index: position,
            content_block: { type: 'thinking', thinking: '', signature: '' } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: position, delta: { type: 'thinking_delta', thinking: block.thinking } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: position,
            delta: { type: 'signature_delta', signature: `stand-in-signature-${index + 1}-${position}` } }]);
        } else {
          events.push(['content_block_start', { type: 'content_block_start', index: position,
            content_block: { type: 'tool_use', id: `toolu_${index + 1}_${position}`, name: block.name, input: {} } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: position,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
        }
        events.push(['content_block_stop', { type: 'content_block_stop', index: position }]);
      });
      const stopReason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens } }]);
      events.push(['message_stop', { type: 'message_stop' }]);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  standIn.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  standIn.close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return standIn;
}

type Callback = (...args: unknown[]) => Promise<unknown>;
interface AdapterOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  abortController: AbortController;
  canUseTool?: Callback;
  hooks?: Record<string, Array<{ hooks: Callback[] }>>;
  mcpServers?: Record<string, { __server: { tools: Array<{ name: string; description: string; shape: Record<string, unknown>; handler: Callback }> } }>;
}

export interface ClaudeSdkRelayOptions {
  /** The stand-in model service's address. */
  baseUrl: () => string;
  /** The Claude home directory of the current run. */
  home: () => string;
  /** Why each Claude Code run ended, from its result message. */
  onResult?: (terminalReason: string | undefined) => void;
  /** The tool-use ids of each PostToolBatch call and what the adapter answered. */
  onToolBatch?: (batch: { toolUseIds: string[]; answer: unknown }) => void;
}

/**
 * The SDK's `query()` for a test's `jest.mock('@anthropic-ai/claude-agent-sdk')`,
 * and `settled()`, which waits until every Claude Code process has exited.
 */
export function createClaudeSdkRelay(relay: ClaudeSdkRelayOptions) {
  const bridges: Array<Promise<void>> = [];

  function relayQuery({ prompt, options }: { prompt: AsyncIterable<unknown>; options: AdapterOptions }) {
    const { env, cwd: _cwd, abortController, canUseTool, hooks = {}, mcpServers = {}, ...plain } = options;
    const frames: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: Error | undefined;
    let bridge: ChildProcessWithoutNullStreams | undefined;
    const send = (line: unknown) => { if (bridge?.stdin.writable) bridge.stdin.write(`${JSON.stringify(line)}\n`); };
    const stop = () => send({ type: 'abort' });
    abortController.signal.addEventListener('abort', stop, { once: true });
    const flatHooks = Object.fromEntries(Object.entries(hooks).map(([event, matchers]) =>
      [event, matchers.flatMap(matcher => matcher.hooks)]));
    const tools = Object.fromEntries(Object.entries(mcpServers).map(([name, config]) => [name, config.__server.tools]));
    const answer = async (call: { target: string; event?: string; index?: number; server?: string; name?: string; args: unknown[] }) => {
      const signal = new AbortController().signal;
      if (call.target === 'canUseTool') {
        const [name, input, opts] = call.args as [string, unknown, Record<string, unknown>];
        return canUseTool!(name, input, { ...opts, signal });
      }
      if (call.target === 'hook') {
        const result = await flatHooks[call.event!][call.index!](call.args[0], call.args[1], { signal });
        if (call.event === 'PostToolBatch') {
          const input = call.args[0] as { tool_calls: Array<{ tool_use_id: string }> };
          relay.onToolBatch?.({ toolUseIds: input.tool_calls.map(entry => entry.tool_use_id), answer: result });
        }
        return result;
      }
      return tools[call.server!].find(definition => definition.name === call.name)!.handler(call.args[0], {});
    };

    async function* run() {
      const first = await prompt[Symbol.asyncIterator]().next();
      const cwd = String(options.cwd);
      await fs.mkdir(cwd, { recursive: true });
      const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...adapterEnv } = env;
      const home = relay.home();
      const config = {
        prompt: first.value,
        options: plain,
        runtime: { cwd, env: { ...adapterEnv,
          HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: relay.baseUrl(), ANTHROPIC_API_KEY: 'offline-stand-in-not-a-secret',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } },
        callbacks: {
          canUseTool: typeof canUseTool === 'function',
          hooks: Object.fromEntries(Object.entries(flatHooks).map(([event, list]) => [event, list.length])),
          mcpServers: Object.fromEntries(Object.entries(tools).map(([name, list]) => [name, list.map(definition => ({
            name: definition.name, description: definition.description, properties: Object.keys(definition.shape ?? {}),
          }))])),
        },
      };
      const child = spawn(process.execPath, [path.join(__dirname, 'claudeRelaySdkBridge.mjs')], {
        cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      });
      bridge = child;
      child.stdin.on('error', () => undefined);
      const stderr: Buffer[] = [];
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
      bridges.push(new Promise<void>(resolve => child.once('close', (code) => {
        if (code !== 0 && !abortController.signal.aborted) failure = new Error(`SDK bridge exit ${code}: ${Buffer.concat(stderr).toString().slice(0, 2000)}`);
        ended = true;
        wake?.();
        resolve();
      })));
      createInterface({ input: child.stdout }).on('line', line => {
        const parsed = JSON.parse(line) as { type: string; id?: number; message?: unknown; target: string; args: unknown[] };
        if (parsed.type === 'frame') {
          const result = parsed.message as { type?: string; terminal_reason?: string };
          if (result.type === 'result') relay.onResult?.(result.terminal_reason);
          frames.push(parsed.message);
          wake?.();
          return;
        }
        answer(parsed).then(
          result => send({ type: 'reply', id: parsed.id, result: result ?? {} }),
          (error: unknown) => send({ type: 'reply', id: parsed.id, error: error instanceof Error ? error.message : String(error) }),
        );
      });
      child.stdin.write(`${JSON.stringify(config)}\n`);
      if (abortController.signal.aborted) stop();
      for (;;) {
        if (frames.length) { yield frames.shift(); continue; }
        if (ended) break;
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
      if (failure) throw failure;
    }
    return Object.assign(run(), { close: stop });
  }

  return { relayQuery, settled: () => Promise.all(bridges).then(() => undefined) };
}
