import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type OpenAI from 'openai';
import { archiveContextForRefit } from '@/backend/execution/flow/handlers/archiveContextForRefit';
import { searchCompactionResource } from '@/backend/services/runResources/searchCompactionResource';
import {
  _setRunResourcesDirForTests, _clearRunResourceSettingsCache, listRunResources, getRunResourceLocalPath,
} from '@/backend/services/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'), loadItem: jest.fn(async (_key, fallback) => fallback),
}));

let directory: string, previous: string;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-context-refit-'));
  previous = _setRunResourcesDirForTests(directory);
  _clearRunResourceSettingsCache();
});
afterAll(async () => {
  _setRunResourcesDirForTests(previous);
  _clearRunResourceSettingsCache();
  await fs.rm(directory, { recursive: true, force: true });
});

it('searches exact roles and source identities across an archive larger than the per-file read limit', async () => {
  const messages: OpenAI.ChatCompletionMessageParam[] = Array.from({ length: 36 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: (index === 0 ? 'ORIGINAL_MARKER: do not publish.\n' : '') + 'é'.repeat(256_000)
      + (index === 35 ? '\nORIGINAL_MARKER: corrected destination Bogotá.' : ''),
  }));
  const ids = messages.map((_message, index) => 'source-' + index);
  const uri = (await archiveContextForRefit(messages, ids, 'large-source', 'node'))!;
  const entries = await listRunResources('large-source');
  expect(entries.reduce((sum, entry) => sum + entry.size, 0)).toBeGreaterThan(16 * 1024 * 1024);
  expect(entries.every(entry => entry.size <= 4 * 1024 * 1024)).toBe(true);
  const result = await searchCompactionResource({ uri, conversationId: 'large-source',
    text: 'ORIGINAL_MARKER', startMessage: 0, maxChars: 4000 });
  expect(result.complete).toBe(true);
  expect(result.matches).toMatchObject([
    { source_message_id: 'source-0', source_role: 'user' },
    { source_message_id: 'source-35', source_role: 'assistant' },
  ]);
  expect(result.matches[1].text).toContain('corrected destination Bogotá.');
  expect(messages[0].content).toContain('do not publish.');
}, 30_000);

it('gives concurrent identical captures the same immutable readable URI', async () => {
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'assistant', content: 'IMMUTABLE_RECEIPT' }];
  const captures = await Promise.all(Array.from({ length: 8 }, () =>
    archiveContextForRefit(messages, ['original'], 'concurrent-source', 'node')));
  expect(new Set(captures).size).toBe(1);
  expect(await listRunResources('concurrent-source')).toHaveLength(1);
  const firstPath = await getRunResourceLocalPath(captures[0]!);
  expect(firstPath).toBeTruthy();
  const other = await archiveContextForRefit(messages, ['original'], 'concurrent-source', 'other-node');
  expect(other).not.toBe(captures[0]);
  expect(await fs.readFile(firstPath!, 'utf8')).toContain('IMMUTABLE_RECEIPT');
  for (const uri of [captures[0]!, other!]) {
    const result = await searchCompactionResource({ uri, conversationId: 'concurrent-source',
      text: 'IMMUTABLE_RECEIPT', startMessage: 0, maxChars: 1000 });
    expect(result.matches[0]).toMatchObject({ source_message_id: 'original', source_role: 'assistant' });
  }
});

it('refuses an indivisible oversized record before issuing an unusable source locator', async () => {
  await expect(archiveContextForRefit([{ role: 'assistant', content: 'x'.repeat(4 * 1024 * 1024) }],
    ['oversized'], 'indivisible-source', 'node')).rejects.toThrow('individual history message');
  expect(await listRunResources('indivisible-source')).toHaveLength(0);
});
