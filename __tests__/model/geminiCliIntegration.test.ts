import http, { type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { GeminiCliRuntime } from '@/backend/services/model/adapters/geminiCliRuntime';

let mockGenAiBaseUrl = '';
let mockRuntime: GeminiCliRuntime | undefined;
let mockStderr = '';
jest.mock('node:child_process', () => {
  const actual = jest.requireActual('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => {
    const child = actual.spawn(...args);
    child.stderr?.on('data', (chunk: Buffer) => { mockStderr = (mockStderr + String(chunk)).slice(-8192); });
    return child;
  } };
});
jest.mock('@/backend/services/model/adapters/geminiCliRuntime', () => {
  const actual = jest.requireActual('@/backend/services/model/adapters/geminiCliRuntime');
  return { ...actual, prepareGeminiCliRuntime: async (...args: unknown[]) => {
    mockRuntime = await actual.prepareGeminiCliRuntime(...args);
    // A test-only loopback endpoint runs the real published CLI without any
    // credentials or external Google request. Production strips this variable.
    mockRuntime!.env.GOOGLE_GEMINI_BASE_URL = mockGenAiBaseUrl;
    return mockRuntime;
  } };
});
jest.mock('@/backend/services/mcp', () => ({ mcpService: {} }));
jest.mock('@/backend/mcpApps/toolUi', () => ({ resolveInvokedToolUiLink: async () => undefined, toolCancellationReason: () => undefined }));
jest.mock('@/backend/services/runResources', () => ({ getRunResourceSettings: async () => ({}) }));
jest.mock('@/backend/services/runResources/boundToolResult', () => ({ boundToolResult: async ({ content }: { content: string }) => ({ spilled: false, content }) }));
jest.mock('@/backend/services/statistics', () => ({ classifyStatisticsError: () => 'tool', createStatisticsEvent: (event: unknown) => event, recordStatisticsEvent: () => {} }));

import { GeminiCliAdapter } from '@/backend/services/model/adapters/geminiCliAdapter';

type GenAiRequest = {
  contents?: Array<{ role?: string; parts?: Array<{ text?: string; functionResponse?: { name: string; response: unknown } }> }>;
  tools?: Array<{ functionDeclarations?: Array<{ name: string }> }>;
};

function respond(res: ServerResponse, streaming: boolean, part: object): void {
  const body = {
    candidates: [{ index: 0, content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
    modelVersion: 'gemini-2.5-flash',
  };
  res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
  res.end(streaming ? `data: ${JSON.stringify(body)}\n\n` : JSON.stringify(body));
}

async function startFakeGenAi(handler: (body: GenAiRequest, res: ServerResponse, streaming: boolean) => void) {
  const requests: GenAiRequest[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as GenAiRequest;
      requests.push(body);
      if (req.url?.includes(':countTokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ totalTokens: 12 }));
        return;
      }
      handler(body, res, Boolean(req.url?.includes(':streamGenerateContent')));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake GenAI endpoint did not bind.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function input(overrides: Partial<CompletionInput> = {}): CompletionInput {
  return {
    model: { id: 'gemini-cli-integration', name: 'gemini-2.5-flash', ApiKey: 'synthetic-local-key', provider: 'gemini-cli', adapter: 'gemini-cli' },
    apiKey: 'synthetic-local-key', messages: [{ role: 'user', content: 'Call controlled_nonce and report its result.' }],
    maxTurns: 4, ...overrides,
  };
}

describe('Gemini CLI published executable integration', () => {
  beforeEach(() => { mockRuntime = undefined; mockStderr = ''; });

  it('runs real CLI streaming through the controlled MCP bridge and records matching tool/result/final messages', async () => {
    const nonce = randomBytes(16).toString('hex');
    const executor = jest.fn(async () => `synthetic-tool-nonce:${nonce}`);
    const approval = jest.fn(async () => true);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    let advertisedNames: string[] = [];
    let requestedTool = false;
    let receivedResult = false;
    const endpoint = await startFakeGenAi((body, res, streaming) => {
      const names = body.tools?.flatMap(tool => tool.functionDeclarations?.map(declaration => declaration.name) ?? []) ?? [];
      const response = body.contents?.flatMap(content => content.parts ?? []).find(part => part.functionResponse);
      if (response) {
        receivedResult = JSON.stringify(response.functionResponse).includes(nonce);
        respond(res, streaming, { text: `Verified ${nonce}` });
      } else if (names.length && !requestedTool) {
        requestedTool = true;
        advertisedNames = names;
        respond(res, streaming, { functionCall: { name: names[0], args: { purpose: 'integration' } } });
      } else {
        respond(res, streaming, { text: 'done' });
      }
    });
    mockGenAiBaseUrl = endpoint.url;
    try {
      const result = await new GeminiCliAdapter().createCompletion(input({
        signal: controller.signal,
        tools: [{ type: 'function', function: { name: 'controlled_nonce', description: 'Returns a synthetic nonce for this test.', parameters: { type: 'object', properties: { purpose: { type: 'string' } } } } }],
        localToolExecutors: { controlled_nonce: executor }, requestToolApproval: approval,
      }));
      expect(requestedTool).toBe(true);
      expect(advertisedNames).toEqual(['mcp_flujo_controlled_nonce']);
      expect(receivedResult).toBe(true);
      expect(approval).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledWith({ purpose: 'integration' });
      expect(result.transcript?.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
      expect(result.transcript![1]).toMatchObject({ role: 'tool', content: JSON.stringify(`synthetic-tool-nonce:${nonce}`) });
      expect(result.completion.choices[0].message.content).toContain(nonce);
      expect(result.completion.usage?.total_tokens).toBeGreaterThan(0);
      await expect(fs.stat(mockRuntime!.home)).rejects.toMatchObject({ code: 'ENOENT' });
    } catch (error) {
      throw new Error(`${String(error)}; executor=${executor.mock.calls.length}; approval=${approval.mock.calls.length}; synthetic responses=${JSON.stringify(endpoint.requests.flatMap(body => body.contents?.flatMap(content => content.parts ?? []) ?? []).filter(part => part.functionResponse))}; synthetic CLI diagnostics: ${mockStderr}`);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await endpoint.close();
      await mockRuntime?.cleanup();
    }
  }, 45_000);

  it('cancels the real subprocess during an outstanding model stream and removes its invocation home', async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    let sawModelStream = false;
    const endpoint = await startFakeGenAi((_body, res, streaming) => {
      if (!streaming) { respond(res, false, { text: 'done' }); return; }
      sawModelStream = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      controller.abort();
    });
    mockGenAiBaseUrl = endpoint.url;
    try {
      await expect(new GeminiCliAdapter().createCompletion(input({ signal: controller.signal })))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(sawModelStream).toBe(true);
      await expect(fs.stat(mockRuntime!.home)).rejects.toMatchObject({ code: 'ENOENT' });
    } catch (error) {
      throw new Error(`${String(error)}; synthetic CLI diagnostics: ${mockStderr}`);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await endpoint.close();
      await mockRuntime?.cleanup();
    }
  }, 45_000);
});
