import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeRunResource, getRunResourceLocalPath, _setRunResourcesDirForTests, _clearRunResourceSettingsCache } from '@/backend/services/runResources';
import { searchCompactionResource } from '@/backend/services/runResources/searchCompactionResource';
import { appendSummaryRanges } from '@/backend/execution/flow/compaction/summaryHierarchy';
import { executeRunResourceTool } from '@/backend/execution/flow/handlers/runResourceTools';
import type { RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'), loadItem: jest.fn(async (_key, defaults) => defaults),
}));
let directory: string, previous: string, root: string;
const store = async (name: string, json: unknown, conversationId = 'search-test') => {
  const result = await writeRunResource({ conversationId, name, kind: 'text', mimeType: 'application/json',
    data: { json }, producedBy: { source: 'compaction-artifact' } });
  if ('skipped' in result) throw new Error('Fixture source unavailable');
  return result;
};
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-summary-search-'));
  previous = _setRunResourcesDirForTests(directory); _clearRunResourceSettingsCache();
  const chunks = Array.from({ length: 20 }, (_, chunk) => Array.from({ length: 10_000 }, (_, offset) => {
    const index = chunk * 10_000 + offset;
    return { id: 'original-' + index, timestamp: index, role: index % 2 ? 'assistant' as const : 'user' as const,
      content: index === 12_345 ? 'Receipt AUDIT-482: {"permitted":false,"committed":true}'
        : index === 190_000 ? 'Correction for AUDIT-482: destination is Bogotá. Never send it.'
          : 'Completed one-off status check ' + index };
  }));
  let sequence = 0;
  root = (await appendSummaryRanges({ previous: [], chunks, inputBudget: 50_000,
    // Deliberately omit the fact: retrieval must recover originals, not merely
    // rediscover an identifier retained by a conveniently perfect summarizer.
    summarize: async () => 'Completed status checks.',
    persist: async payload => (await store('range-' + sequence++, payload)).uri,
  })).resourceUri;
}, 60_000);
afterAll(async () => {
  _setRunResourcesDirForTests(previous); _clearRunResourceSettingsCache();
  await fs.rm(directory, { recursive: true, force: true });
});
it('recovers omitted facts and later corrections across 200,000 original messages with exact roles', async () => {
  const outcome = await executeRunResourceTool('read_resource', { uri: root, search_text: 'AUDIT-482' }, { conversationId: 'search-test' });
  expect(outcome.success).toBe(true);
  expect(outcome.data).toMatchObject({ complete: true, searchedThroughMessage: 200_000, matches: [
    { source_message_id: 'original-12345', source_role: 'assistant', text: 'Receipt AUDIT-482: {"permitted":false,"committed":true}' },
    { source_message_id: 'original-190000', source_role: 'user', text: 'Correction for AUDIT-482: destination is Bogotá. Never send it.' },
  ] });
  expect((outcome.data as { resourcesRead: number }).resourcesRead).toBeLessThan(30);
});
it('paginates a broad search without dropping or repeating the boundary message', async () => {
  const ids: string[] = [];
  let startMessage = 199_950;
  do {
    const result = await searchCompactionResource({ uri: root, conversationId: 'search-test', text: 'Completed', startMessage, maxChars: 1500 });
    ids.push(...result.matches.map(match => match.source_message_id));
    if (result.complete) break;
    expect(result.next_message).toBeGreaterThan(startMessage);
    startMessage = result.next_message!;
  } while (ids.length < 100);
  expect(ids).toEqual(Array.from({ length: 50 }, (_, index) => 'original-' + (199_950 + index)));
});

it('resolves an exact original message ID without requiring that ID to appear in its text', async () => {
  const result = await searchCompactionResource({ uri: root, conversationId: 'search-test',
    text: 'original-190000', startMessage: 0, maxChars: 2000 });
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({ source_message_id: 'original-190000', source_role: 'user',
    source_start: 0, text: 'Correction for AUDIT-482: destination is Bogotá. Never send it.' });
  const partial = await searchCompactionResource({ uri: root, conversationId: 'search-test',
    text: 'original-190', startMessage: 0, maxChars: 2000 });
  // This prefix is itself a real ID; it must resolve only that exact message,
  // never original-190000 or the other messages sharing its prefix.
  expect(partial.matches.map(match => match.source_message_id)).toEqual(['original-190']);
});
it('does not follow cross-conversation children or accept altered source bytes', async () => {
  const foreign = await store('foreign', [{ id: 'secret', role: 'user', content: 'secret text' }], 'other-run');
  const parent = await store('bad-parent', { children: [{ resourceUri: foreign.uri, sourceMessageCount: 1 }] });
  await expect(searchCompactionResource({ uri: parent.uri, conversationId: 'search-test', text: 'secret', startMessage: 0, maxChars: 1000 }))
    .rejects.toThrow('this conversation');
  const tampered: RunResourceEntry = await store('tampered', [{ id: 'source', role: 'user', content: 'before' }]);
  await fs.writeFile((await getRunResourceLocalPath(tampered.uri))!, '[]');
  await expect(searchCompactionResource({ uri: tampered.uri, conversationId: 'search-test', text: 'before', startMessage: 0, maxChars: 1000 }))
    .rejects.toThrow('integrity');
});
