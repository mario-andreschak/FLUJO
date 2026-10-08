import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { parseCodexTokenSnapshot, readCodexTokenSnapshot } from '@/backend/services/model/adapters/codexContextUsage';
import { subtractCodexUsage } from '@/backend/services/model/adapters/codexUsage';

const threadId = '01a0ba76-e5e0-7a12-823b-5eed320794ca';
const event = {
  timestamp: '2026-09-19T16:30:12.772Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 5606187, cached_input_tokens: 5432064, output_tokens: 27510 },
      last_token_usage: { input_tokens: 165897, cached_input_tokens: 164864, output_tokens: 390, total_tokens: 166287 },
      model_context_window: 258400,
    },
  },
};

describe('Codex context and accumulated usage', () => {
  it('separates the screenshot’s 5.6M processed input from the actual 166k context', () => {
    const snapshot = parseCodexTokenSnapshot(JSON.stringify(event))!;
    expect(snapshot.totalUsage.input_tokens).toBe(5606187);
    expect(snapshot.contextUsage).toEqual({
      promptTokens: 165897, completionTokens: 390, totalTokens: 166287, contextWindow: 258400, contextWindowSource: 'runtime',
    });
  });

  it('does not substitute configured limits, cumulative counts, or malformed data', () => {
    expect(parseCodexTokenSnapshot('{"type":"token_count"')).toBeUndefined();
    const missing = structuredClone(event);
    Reflect.deleteProperty(missing.payload.info, 'last_token_usage');
    expect(parseCodexTokenSnapshot(JSON.stringify(missing))).toBeUndefined();
    const invalid = structuredClone(event);
    invalid.payload.info.last_token_usage.input_tokens = -1;
    expect(parseCodexTokenSnapshot(JSON.stringify(invalid))).toBeUndefined();
    const noWindow = structuredClone(event);
    Reflect.deleteProperty(noWindow.payload.info, 'model_context_window');
    expect(parseCodexTokenSnapshot(JSON.stringify(noWindow))?.contextUsage.contextWindow).toBeUndefined();
  });

  it('counts only new usage when resuming a native thread', () => {
    expect(subtractCodexUsage(
      { input_tokens: 5606187, cached_input_tokens: 5432064, output_tokens: 27510, cache_write_input_tokens: 200 },
      { input_tokens: 5000000, cached_input_tokens: 4900000, output_tokens: 25000, cache_write_input_tokens: 150 },
    )).toEqual({ input_tokens: 606187, cached_input_tokens: 532064, output_tokens: 2510, cache_write_input_tokens: 50 });
  });
});

describe('bounded native rollout reader', () => {
  let home: string;
  let file: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-context-test-'));
    const directory = path.join(home, 'sessions', '2026', '09', '19');
    await fs.mkdir(directory, { recursive: true });
    file = path.join(directory, `rollout-2026-09-19T11-19-09-${threadId}.jsonl`);
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reads the latest complete event past large tool output and a partial live write', async () => {
    const compacted = structuredClone(event);
    compacted.payload.info.last_token_usage.input_tokens = 12000;
    compacted.payload.info.last_token_usage.cached_input_tokens = 10000;
    compacted.payload.info.last_token_usage.total_tokens = 12390;
    await fs.writeFile(file, [JSON.stringify(event), JSON.stringify(compacted),
      JSON.stringify({ type: 'response_item', payload: 'x'.repeat(150000) }), '{"type":"event_msg"'].join('\n'));
    expect((await readCodexTokenSnapshot(home, threadId))?.contextUsage.totalTokens).toBe(12390);
    await fs.appendFile(file, '\n' + JSON.stringify(event) + '\n');
    expect((await readCodexTokenSnapshot(home, threadId))?.contextUsage.totalTokens).toBe(166287);
  });

  it('returns unknown for missing files, unsafe IDs, and a tail beyond the read budget', async () => {
    expect(await readCodexTokenSnapshot(home, threadId)).toBeUndefined();
    expect(await readCodexTokenSnapshot(home, '../outside')).toBeUndefined();
    await fs.writeFile(file, JSON.stringify(event) + '\n' + 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(await readCodexTokenSnapshot(home, threadId)).toBeUndefined();
  });
});
