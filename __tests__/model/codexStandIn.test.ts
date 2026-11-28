/**
 * FLUJO's real Codex adapter, the real bundled Codex CLI and FLUJO's real tool
 * bridge, with the local model stand-in from scripts/codex-stand-in.mjs. No
 * login, account or real model; nothing leaves 127.0.0.1.
 *
 * Proves that cancelling while a FLUJO tool works, or while its approval is
 * open, ends the Codex turn, every process Codex started and the pending
 * approval; and that Codex's own compaction gets FLUJO's standing user
 * instructions and receipts right after its summary.
 */
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import { registerPendingApproval, listPendingToolCalls, clearPendingApprovals } from '@/backend/execution/flow/toolApprovalRegistry';
import { NATIVE_COMPACTION_CARRY_HEADING } from '@/backend/execution/flow/compaction/nativeCompactionCarry';
import { bundledCodex, descendantProcessIds, listProcesses, offeredTool, prepareStandInHome, startStandInModel, STAND_IN_MODEL } from '../../scripts/codex-stand-in.mjs';

const mockRuntime: { executable?: string; home?: string; workspace?: string; env?: Record<string, string> } = {};
jest.mock('@/backend/services/model/adapters/codexRuntimeUpdate', () => ({
  acquireOrdinaryCodexExecutable: async () => ({ executable: mockRuntime.executable, release: async () => {} }),
  readOrdinaryCodexVersion: async () => undefined,
  readCodexRuntimeCompatibility: async () => ({}),
}));
jest.mock('@/backend/services/model/adapters/codexModelCatalog', () => ({ prepareCodexModelCatalogSnapshot: async () => undefined }));
jest.mock('@/backend/services/model/adapters/codexRuntimeHome', () => ({
  prepareCodexRuntimeEnvironment: async () => ({ home: mockRuntime.home, workingDirectory: mockRuntime.workspace, env: mockRuntime.env }),
}));
jest.mock('@/backend/services/model/allowance/codex', () => ({
  readCodexAllowanceAccountKey: async () => undefined, recordCodexRateLimitUpdate: () => {},
}));
const mockCallTool = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => mockCallTool(...args),
    getClient: () => ({}), getClientGeneration: () => 1, getToolSchemaHash: () => 'schema',
    loadServerConfigs: async () => [], listServerTools: async () => ({ tools: [] }), isMcpAppAccessEnabled: async () => false,
  },
}));
jest.mock('@/backend/services/runResources', () => ({ getRunResourceSettings: async () => ({}) }));
jest.mock('@/backend/services/runResources/boundToolResult', () => ({
  boundToolResult: async ({ content }: { content: string }) => ({ spilled: false, content }),
}));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: async () => null }));

jest.setTimeout(120_000);
const TOOL = 'files__write';
let model: Awaited<ReturnType<typeof startStandInModel>>;
let place: Awaited<ReturnType<typeof prepareStandInHome>>;
let callTool = false;

async function useStandIn(options: { inputTokens?: () => number; config?: string[] } = {}) {
  model = await startStandInModel({
    inputTokens: options.inputTokens,
    // One request calls FLUJO's tool; every other one answers normally.
    reply: (body: unknown) => {
      const tool = offeredTool(body, TOOL);
      if (!callTool || !tool) return undefined;
      callTool = false;
      return { toolCall: { ...tool, arguments: { path: 'notes.txt' } } };
    },
  });
  place = await prepareStandInHome(model.port, { config: options.config });
  Object.assign(mockRuntime, { executable: bundledCodex().executable, home: place.codexHome, workspace: place.workspace, env: place.env });
}
afterEach(async () => {
  callTool = false;
  mockCallTool.mockReset();
  await model?.close();
  await place?.remove();
});

const input = (overrides: Partial<CompletionInput>): CompletionInput => ({
  model: { id: 'stand-in', name: STAND_IN_MODEL, provider: 'codex', adapter: 'codex-cli' },
  apiKey: '',
  messages: [{ id: 'u1', role: 'user', content: 'Write the notes file.', timestamp: 1 }],
  tools: [{ type: 'function', function: { name: 'mcp_files_write', description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  toolNameMap: { mcp_files_write: { server: 'files', tool: 'write' } },
  ...overrides,
} as unknown as CompletionInput);

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Starts a run, waits for `ready`, notes every process the run started,
 * cancels, and returns what was still alive afterwards. */
async function cancelDuringTool(overrides: Partial<CompletionInput>, ready: () => boolean) {
  const before = await descendantProcessIds();
  const controller = new AbortController();
  const transcript: FlujoChatMessage[] = [];
  const running = new CodexAdapter().createCompletion(input({ signal: controller.signal,
    onTranscriptMessage: message => { transcript.push(message); }, ...overrides }));
  const outcome = running.then(() => 'returned', error => (error as Error).message);
  await waitUntil(ready, 'the tool call to reach FLUJO');
  const started = [...await descendantProcessIds()].filter(pid => !before.has(pid));
  controller.abort();
  const settled = await outcome;
  let alive: number[] = [];
  await waitUntil(async () => {
    const table = await listProcesses();
    alive = started.filter(pid => table.has(pid));
    return alive.length === 0;
  }, 'every process the run started to end', 20_000).catch(() => {});
  const leftover = [...await descendantProcessIds()].filter(pid => !before.has(pid));
  return { started, alive, leftover, settled, transcript };
}

it('cancelling while a FLUJO tool is working ends the turn, the tool call and every Codex process', async () => {
  await useStandIn();
  callTool = true;
  let toolSignal: AbortSignal | undefined;
  mockCallTool.mockImplementation((_server, _tool, _args, _timeout, _progress, _node, signal: AbortSignal) => {
    toolSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ success: false, error: 'cancelled' }), { once: true }));
  });
  const { started, alive, leftover, settled } = await cancelDuringTool({}, () => Boolean(toolSignal));
  expect(started.length).toBeGreaterThan(0);
  expect(toolSignal!.aborted).toBe(true);
  expect(settled).not.toBe('returned');
  expect(alive).toEqual([]);
  expect(leftover).toEqual([]);
});

it('cancelling while a FLUJO tool waits for approval clears the approval, records why and ends every Codex process', async () => {
  await useStandIn();
  callTool = true;
  const conversationId = 'codex-stand-in-approval';
  let asked = false;
  try {
    const { alive, leftover, settled, transcript } = await cancelDuringTool({
      conversationId,
      requestToolApproval: call => new Promise<boolean>(resolve => {
        registerPendingApproval(conversationId, { id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) } }, resolve);
        asked = true;
      }),
    }, () => asked);
    expect(settled).not.toBe('returned');
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(listPendingToolCalls(conversationId)).toEqual([]);
    expect(transcript.find(message => message.role === 'tool')?.content).toContain('ended before approval');
    expect(alive).toEqual([]);
    expect(leftover).toEqual([]);
  } finally { clearPendingApprovals(conversationId); }
});

it('when Codex compacts on its own, FLUJO\'s standing instructions and receipts reach the model right after the summary', async () => {
  // Large token counts and a low limit make Codex compact after the tool call.
  await useStandIn({ inputTokens: () => 5000, config: ['model_auto_compact_token_limit = 3000', 'model_context_window = 100000'] });
  callTool = true;
  mockCallTool.mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'written' }] } });
  const result = await new CodexAdapter().createCompletion(input({
    messages: [
      { id: 'u1', role: 'user', content: 'Never delete files in this folder.', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2,
        tool_calls: [{ id: 'call-earlier', type: 'function', function: { name: 'files__read', arguments: '{"path":"a.txt"}' } }] },
      { id: 't1', role: 'tool', tool_call_id: 'call-earlier', content: 'old contents', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Write the notes file.', timestamp: 4 },
    ] as FlujoChatMessage[],
  }));
  expect(result.completion.choices[0].message.content).toMatch(/^Fixture reply \d+\.$/);
  const compactions = model.requestsContaining('CONTEXT CHECKPOINT COMPACTION');
  expect(compactions.length).toBeGreaterThan(0);
  // The answering request: Codex's summary first, then FLUJO's carry as its own user message.
  const texts = (model.requests.at(-1) as { input: { role?: string; content?: { text?: string }[] }[] }).input
    .map(item => item.role === 'user' ? (item.content ?? []).map(part => part.text ?? '').join('') : '');
  const summary = texts.findIndex(text => text.includes('Fixture summary'));
  const carry = texts.findIndex(text => text.startsWith(NATIVE_COMPACTION_CARRY_HEADING));
  expect(summary).toBeGreaterThanOrEqual(0);
  expect(carry).toBeGreaterThan(summary);
  expect(texts[carry]).toContain('1. Never delete files in this folder.');
  // Receipts: the earlier call and the one made in this turn, with their exact ids.
  expect(texts[carry]).toContain('"call_id":"call-earlier","tool":"files__read","state":"result-observed"');
  expect(texts[carry]).toMatch(/"tool":"files__write","state":"result-observed"/);
});
