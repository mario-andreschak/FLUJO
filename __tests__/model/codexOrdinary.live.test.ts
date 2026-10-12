import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type OpenAI from 'openai';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import type { SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import { _clearCodexSessionsForTests } from '@/backend/services/model/adapters/codexSessionStore';
import type { CodexSessionMetadata } from '@/backend/execution/flow/types';
import { readCodexRuntimeCompatibility, acquireOrdinaryCodexExecutable } from '@/backend/services/model/adapters/codexRuntimeUpdate';

// Focused opt-in acceptance only. It uses existing file-backed Codex login,
// production adapter/bridge and actual bundled read-only filesystem MCP.
const root = process.env.FLUJO_CODEX_ORDINARY_ACCEPTANCE_ROOT;
const live = root && process.env.FLUJO_CODEX_ORDINARY_ACCEPTANCE === '1' ? it : it.skip;
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  getWorkspaceDataDir: () => path.join(process.env.FLUJO_CODEX_ORDINARY_ACCEPTANCE_ROOT!, 'runtime'),
  getCurrentWorkspace: () => 'codex-ordinary-acceptance',
}));
live('accepts real inference/MCP, durable restart resume, protocol usage and owned cancellation', async () => {
  const previousUpdate = process.env.FLUJO_CODEX_AUTO_UPDATE, previousTransport = process.env.FLUJO_CODEX_APP_SERVER;
  process.env.FLUJO_CODEX_AUTO_UPDATE = '0';
  process.env.FLUJO_CODEX_APP_SERVER = '1';
  if (!path.isAbsolute(root!)) throw new Error('Absolute owned acceptance root required.');
  const relative = path.relative(process.cwd(), root!);
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Acceptance data must remain outside the checkout.');
  await fs.mkdir(root!, { recursive: true });
  const controller = new AbortController();
  const client = new Client({ name: 'flujo-codex-acceptance', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('mcp-servers/filesystem/dist/index.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      FLUJO_FS_ROOTS: root!, FLUJO_DATA_DIR: path.join(root!, 'filesystem-data') }, stderr: 'pipe',
  });
  const receipt: Record<string, unknown> = { model: 'gpt-6-luna', reasoningEffort: 'medium', route: 'existing ChatGPT file login',
    startedAt: new Date().toISOString(), paidCostUsd: null };
  let calls = 0, session: CodexSessionMetadata | undefined;
  const dispatches: SdkRequestSnapshot[] = [];
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const tool = catalog.tools.find(tool => tool.name === 'get_allowed_directories');
    if (!tool) throw new Error('Bundled filesystem MCP discovery failed.');
    const phrase = 'CODEX_ACCEPTANCE_' + randomUUID().replaceAll('-', '');
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'Use FLUJO tools for their operations. Remember the user code phrase for follow-up turns.' },
      { role: 'user', content: `Remember this code phrase: ${phrase}. Call filesystem__get_allowed_directories exactly once, then reply exactly READY.` },
    ];
    const shared = {
      model: { id: 'acceptance', name: 'gpt-6-luna', adapter: 'codex-cli' as const, provider: 'openai' as const, ApiKey: '', reasoningEffort: 'medium' as const },
      apiKey: '', conversationId: 'ordinary-live-' + randomUUID(), nodeId: 'process', sessionResume: true,
      tools: [{ type: 'function' as const, function: { name: 'filesystem__get_allowed_directories', description: tool.description!, parameters: tool.inputSchema } }],
      localToolExecutors: { filesystem__get_allowed_directories: async () => { calls++; return await client.callTool({ name: 'get_allowed_directories', arguments: {} }); } },
      requestToolApproval: async () => true,
      onCodexSessionChange: (next: CodexSessionMetadata | undefined) => { session = next; },
      onSdkRequest: async (snapshot: SdkRequestSnapshot) => { dispatches.push(snapshot); return undefined; },
    };
    const first = await new CodexAdapter().createCompletion({ ...shared, messages, signal: controller.signal });
    expect(first.completion.choices[0].message.content?.trim()).toBe('READY');
    expect(calls).toBe(1);
    expect(first.transcript?.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(first.transcript?.filter(message => message.role === 'assistant' && message.tool_calls?.length)).toHaveLength(1);
    expect(session?.totalUsage?.input_tokens).toBeGreaterThan(0);
    expect(first.contextUsage?.contextWindowSource).toBe('runtime');
    receipt.first = { status: 'completed', mcpCalls: calls, usage: first.completion.usage, context: first.contextUsage };
    const persisted = JSON.parse(JSON.stringify(session!)) as CodexSessionMetadata;
    messages.push(...first.transcript! as OpenAI.ChatCompletionMessageParam[], { role: 'user', content: 'Reply with only the code phrase I gave you before.' });
    _clearCodexSessionsForTests();
    const resumed = await new CodexAdapter().createCompletion({ ...shared, messages, codexSession: persisted, signal: controller.signal });
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].operation).toBe('app-server.turn/start');
    expect(JSON.stringify(dispatches[1].request)).toContain('Reply with only the code phrase');
    expect(JSON.stringify(dispatches[1].request)).not.toContain(phrase);
    expect(resumed.completion.choices[0].message.content?.trim()).toBe(phrase);
    expect(session?.threadId).toBe(persisted.threadId);
    expect(calls).toBe(1);
    expect(resumed.completion.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(resumed.completion.usage!.prompt_tokens).toBeLessThan(session!.totalUsage!.input_tokens!);
    receipt.restartResume = { sameThread: true, appendedInputOnly: true, noDuplicateMcpCalls: true, usage: resumed.completion.usage, context: resumed.contextUsage };
    messages.push(...resumed.transcript! as OpenAI.ChatCompletionMessageParam[], { role: 'user', content: 'Explain prime numbers in about 1200 words. Do not use tools.' });
    let steeringReady = false, delivered = false, listener: (() => void) | undefined, acknowledgements = 0, requeues = 0;
    const steered = await new CodexAdapter().createCompletion({ ...shared, messages, codexSession: session,
      steering: {
        subscribe: next => { listener = next; return () => { listener = undefined; }; },
        take: async () => {
          if (!steeringReady || delivered) return undefined;
          delivered = true;
          return { messages: [{ id: randomUUID(), timestamp: Date.now(), role: 'user', content: 'Stop the explanation. Reply with only STEERED.' }],
            beforeSend: async () => {}, acknowledge: async () => { acknowledgements++; }, requeue: () => { requeues++; } };
        },
      },
      onModelDelta: delta => { if (delta.contentDelta && !steeringReady) { steeringReady = true; listener?.(); } },
    });
    expect(steered.completion.choices[0].message.content?.trim()).toBe('STEERED');
    expect(acknowledgements).toBe(1); expect(requeues).toBe(0);
    expect(dispatches).toHaveLength(3);
    receipt.steering = { duringVisibleOutput: steeringReady, acknowledgements, requeues, replacementTurns: 0, usage: steered.completion.usage };
    const cancel = new AbortController(), partial: string[] = [];
    let visibleDelta = false;
    const beforeCancellation = dispatches.length;
    await expect(new CodexAdapter().createCompletion({ ...shared, sessionResume: false,
      messages: [{ role: 'user', content: 'Explain prime numbers in about 1200 words. Do not use tools.' }], signal: cancel.signal,
      onModelDelta: delta => { if (delta.contentDelta) { visibleDelta = true; cancel.abort(); } },
      onTranscriptMessage: message => { if (typeof message.content === 'string') partial.push(message.content); },
    })).rejects.toThrow();
    expect(partial.join('').length).toBeGreaterThan(0);
    expect(visibleDelta).toBe(true); expect(cancel.signal.aborted).toBe(true);
    expect(dispatches).toHaveLength(beforeCancellation + 1);
    receipt.cancellation = { afterVisibleOutput: true, partialPreserved: true, noReplacementTurn: true };
    const lease = await acquireOrdinaryCodexExecutable();
    try { receipt.runtime = await readCodexRuntimeCompatibility(lease.executable); }
    finally { await lease.release(); }
    receipt.outcome = 'passed';
  } catch (error) {
    receipt.outcome = 'failed'; receipt.errorClass = error instanceof Error ? error.name : 'unknown';
    throw error;
  } finally {
    if (previousUpdate === undefined) delete process.env.FLUJO_CODEX_AUTO_UPDATE;
    else process.env.FLUJO_CODEX_AUTO_UPDATE = previousUpdate;
    if (previousTransport === undefined) delete process.env.FLUJO_CODEX_APP_SERVER;
    else process.env.FLUJO_CODEX_APP_SERVER = previousTransport;
    controller.abort();
    await client.close(); await transport.close();
    receipt.observedAt = new Date().toISOString();
    await fs.writeFile(path.join(root!, 'acceptance.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
}, 180000);
