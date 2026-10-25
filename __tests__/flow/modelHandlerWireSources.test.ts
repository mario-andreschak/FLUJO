import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FlujoChatMessage } from '@/shared/types/chat';

const getModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: (...args: unknown[]) => getModelMock(...args),
  resolveAndDecryptApiKey: async () => 'offline-fixture',
} }));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => new OpenAiAdapter(),
}));

import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { _setModelTurnArchiveDirForTests, readModelTurnSnapshot } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

it('continues on the OpenAI route after handoff projection and archives unchanged canonical history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-wire-sources-'));
  const priorArchive = _setModelTurnArchiveDirForTests(path.join(root, 'archives'));
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1, model: 'offline-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Continued.' } }] }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    getModelMock.mockResolvedValue({ id: 'wire-model', name: 'offline-model', displayName: 'Offline', provider: 'openai',
      adapter: 'openai', ApiKey: 'offline-fixture', inputModalities: ['text'], outputModalities: ['text'],
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    const messages: FlujoChatMessage[] = [
      { id: 'instruction', timestamp: 1, role: 'system', content: 'Continue the parent after its children settle.' },
      { id: 'task', timestamp: 2, role: 'user', content: 'Review the project.' },
      { id: 'handoff', timestamp: 3, role: 'assistant', content: '', tool_calls: [
        { id: 'route', type: 'function', function: { name: 'handoff_to_explorer', arguments: '{}' } },
      ] },
      { id: 'ack', timestamp: 4, role: 'tool', tool_call_id: 'route', content: 'Handoff processed.' },
      { id: 'continue', timestamp: 5, role: 'user', content: 'The handoff was successful. Continue' },
      { id: 'child-result', timestamp: 6, role: 'assistant', content: 'One child failed with HTTP 400.' },
    ];
    const before = JSON.stringify(messages);
    const result = await (ModelHandler as unknown as { generateCompletion: (
      model: string, prompt: string, messages: FlujoChatMessage[], tools: undefined, opts: Record<string, unknown>,
    ) => Promise<{ success: boolean }> }).generateCompletion('wire-model', '', messages, undefined, {
      archiveModelTurns: true, canonicalMessages: messages, wireMessageIds: messages.map(message => message.id),
      conversationId: 'wire-parent', nodeId: 'process', runId: 'wire-run',
    });
    expect(result).toMatchObject({ success: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([
      { role: 'user', content: 'Review the project.' },
      { role: 'assistant', content: 'One child failed with HTTP 400.' },
      { role: 'system', content: 'Continue the parent after its children settle.' },
    ]);
    const files = (await fs.readdir(path.join(root, 'archives', 'wire-parent'))).filter(name => name.endsWith('.v2.json.gz'));
    expect(files).toHaveLength(1);
    const snapshot = await readModelTurnSnapshot('wire-parent', files[0].slice(0, -'.v2.json.gz'.length));
    expect(snapshot!.entry.outcome).toBe('completed');
    expect(snapshot!.canonicalMessages).toEqual(messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
  } finally {
    _setModelTurnArchiveDirForTests(priorArchive);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.stdout.write(`FLUJO_WIRE_SOURCES_FIXTURE ${root}\n`);
  }
}, 30_000);
