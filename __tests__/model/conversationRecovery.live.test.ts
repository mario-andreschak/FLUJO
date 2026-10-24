import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { modelService } from '@/backend/services/model';
import { executeRunResourceTool } from '@/backend/execution/flow/handlers/runResourceTools';
import { isChatGptAuthCache } from '@/backend/services/model/adapters/codexAuth';
import type { Model } from '@/shared/types/model';
import type { FlujoChatMessage } from '@/shared/types/chat';

// Opt-in source acceptance, with real inference and the production archive,
// resource capture, reader and adapters. All generated state stays private.
const root = process.env.FLUJO_RECOVERY_ACCEPTANCE_ROOT;
const live = root && process.env.FLUJO_RECOVERY_ACCEPTANCE === '1' ? it : it.skip;
live.each(['codex', 'openrouter'] as const)('continues through an oversized tool result on %s', async route => {
  if (!root || !path.isAbsolute(root) || !path.relative(process.cwd(), root).startsWith('..')) throw new Error('Private absolute acceptance root required');
  const source = process.env.FLUJO_RECOVERY_SOURCE_ROOT!;
  const priorData = process.env.FLUJO_DATA_DIR;
  const priorUpdate = process.env.FLUJO_CODEX_AUTO_UPDATE;
  const receipt: Record<string, unknown> = { route, startedAt: new Date().toISOString(), status: 'running' };
  let spy: jest.SpyInstance | undefined;
  try {
    let model: Model;
    let key = '';
    if (route === 'codex') {
      const auth = await fs.readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'));
      expect(isChatGptAuthCache(auth)).toBe(true);
      model = { id: 'live-codex', name: 'gpt-6-luna', provider: 'codex', adapter: 'codex-cli', ApiKey: '',
        contextWindow: 280_000, maxTokens: 4_000, reasoningEffort: 'medium' } as Model;
      receipt.authentication = 'verified ChatGPT subscription cache; empty API key';
    } else {
      const models: Model[] = JSON.parse(await fs.readFile(path.join(source, 'workspaces/default-workspace/db/models.json'), 'utf8'));
      const saved = models.find(model => model.name === 'openrouter/free' && model.provider === 'openrouter');
      if (!saved || new URL(saved.baseUrl!).origin !== 'https://openrouter.ai') throw new Error('Approved Free connection unavailable');
      process.env.FLUJO_DATA_DIR = source;
      key = await modelService.resolveAndDecryptApiKey(saved.ApiKey) || '';
      if (!key) throw new Error('Approved Free credential unavailable');
      model = { ...saved, id: 'live-openrouter', name: 'openrouter/free', adapter: 'openai-responses',
        contextWindow: 32_768, maxTokens: 4_000, fallbackPolicy: undefined, ApiKey: key };
      receipt.authentication = 'existing OpenRouter credential, Free route only';
    }
    receipt.model = model.name;
    process.env.FLUJO_DATA_DIR = path.join(root, route);
    process.env.FLUJO_CODEX_AUTO_UPDATE = '0';
    spy = jest.spyOn(modelService, 'getModel').mockImplementation(async id => {
      if (id !== model.id) throw new Error('Unapproved model route');
      return model;
    });
    const phrase = 'RECOVERED_' + randomUUID().replaceAll('-', '');
    const body = 'x'.repeat(1_100_000) + '\n' + phrase;
    const conversationId = 'recovery-' + randomUUID();
    let messages: FlujoChatMessage[] = [
      { id: 'u', timestamp: 1, role: 'user', content: 'The read result below has a code at its end. Use read_resource with start_char=1100000 and max_chars=200 to read that exact end from the stored resource URI. Reply with only the code. Do not repeat the original read or guess.' },
      { id: 'a', timestamp: 2, role: 'assistant', content: '', tool_calls: [{ id: 'large-read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { id: 't', timestamp: 3, role: 'tool', tool_call_id: 'large-read', content: body },
    ];
    let answer = '', reads = 0;
    for (let iteration = 0; iteration < 4; iteration++) {
      const result = await ModelHandler.callModel({ modelId: model.id, prompt: '', messages,
        conversationId, nodeId: 'recovery', nodeName: 'Recovery', iteration, maxIterations: 4,
        requireToolApproval: false });
      if (!result.success) throw new Error('Live completion failed: ' + result.error.code);
      messages = result.value.messages;
      answer = result.value.content?.trim() ?? '';
      if (!result.value.toolCalls?.length) break;
      for (const call of result.value.toolCalls) {
        expect(call.name).toBe('read_resource');
        const outcome = await executeRunResourceTool(call.name, call.args, { conversationId, node: { nodeId: 'recovery' } });
        expect(outcome.success).toBe(true);
        reads++;
        messages.push({ id: randomUUID(), timestamp: Date.now(), role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.data) });
      }
    }
    expect(answer).toBe(phrase);
    expect(messages.find(message => message.id === 't')?.content).toBe(body);
    const resources = messages.filter(message => message.role === 'tool' && message.tool_call_id !== 'large-read');
    expect(reads + resources.length).toBeGreaterThan(0);
    Object.assign(receipt, { status: 'passed', exactTailRecovered: true, canonicalOriginalPreserved: true,
      inputCharacters: body.length, explicitReaderCalls: reads, continuedMessages: messages.length });
  } catch (error) {
    receipt.status = 'failed';
    receipt.errorClass = error instanceof Error ? error.name : 'unknown';
    throw error;
  } finally {
    spy?.mockRestore();
    if (priorData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = priorData;
    if (priorUpdate === undefined) delete process.env.FLUJO_CODEX_AUTO_UPDATE; else process.env.FLUJO_CODEX_AUTO_UPDATE = priorUpdate;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, route + '-receipt.json'), JSON.stringify(receipt, null, 2));
  }
}, 240_000);
