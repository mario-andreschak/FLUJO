/** @jest-environment jsdom */

import { personasService } from '@/frontend/services/personas';
import type { MemoryItem } from '@/shared/types/enduringAgent';

const memory: MemoryItem = {
  schemaVersion: 1,
  id: 'memory_release',
  personaId: 'persona_jim',
  kind: 'semantic',
  scope: 'persona',
  status: 'active',
  content: 'The release window is in February.',
  confidence: 1,
  importance: 0.5,
  sourceRefs: [{ kind: 'user_statement', id: 'statement_release' }],
  trust: 'explicit_user',
  validFrom: 1_800_000_000_123,
  validUntil: 1_801_000_000_456,
  createdAt: 10,
  updatedAt: 11,
};

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn();

function requestBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('personasService memory availability', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => memory,
    } as Response);
    globalThis.fetch = fetchMock;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes optional useful-from and useful-until dates when creating a memory', async () => {
    await personasService.createMemory(memory.personaId, {
      content: memory.content,
      requestId: memory.id,
      validFrom: memory.validFrom,
      validUntil: memory.validUntil,
    });

    expect(requestBody()).toMatchObject({
      id: memory.id,
      content: memory.content,
      validFrom: memory.validFrom,
      validUntil: memory.validUntil,
    });
  });

  it('preserves existing dates by default and lets an explicit empty edit clear them', async () => {
    await personasService.correctMemory(memory.personaId, memory, 'Updated release window.');
    expect(requestBody()).toMatchObject({
      content: 'Updated release window.',
      validFrom: memory.validFrom,
      validUntil: memory.validUntil,
    });

    await personasService.correctMemory(memory.personaId, memory, 'Always useful.', {});
    expect(requestBody()).not.toHaveProperty('validFrom');
    expect(requestBody()).not.toHaveProperty('validUntil');
  });

  it('serializes backwards-compatible string searches and typed review options', async () => {
    await personasService.memories(memory.personaId, ' release window ');
    let requestUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(requestUrl.searchParams.get('q')).toBe('release window');
    expect(requestUrl.searchParams.get('limit')).toBe('200');

    await personasService.memories(memory.personaId, {
      statuses: ['candidate'],
      order: 'review',
      limit: 20,
    });
    requestUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(requestUrl.searchParams.get('status')).toBe('candidate');
    expect(requestUrl.searchParams.get('order')).toBe('review');
    expect(requestUrl.searchParams.get('limit')).toBe('20');
  });

  it('posts the authoritative conflict resolution contract', async () => {
    await personasService.resolveMemoryConflict(memory.personaId, memory.id, {
      counterpartId: 'memory_counterpart',
      action: 'keep_left',
      reason: 'The user-confirmed release window is authoritative.',
      resolutionId: 'memory_resolution_test',
    });

    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      '/memories/memory_release/resolve-conflict',
    );
    expect(requestBody()).toEqual({
      counterpartId: 'memory_counterpart',
      action: 'keep_left',
      reason: 'The user-confirmed release window is authoritative.',
      resolutionId: 'memory_resolution_test',
    });
  });
});
