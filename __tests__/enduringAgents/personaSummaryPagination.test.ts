import { listPersonaSummaries } from '@/backend/services/enduringAgents/personaSummary';
import { createPersona, listPersonas } from '@/backend/services/enduringAgents/store';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import { deleteCollectionItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

let sequence = 0;

async function withMixedCasePersonas(task: (ids: string[]) => Promise<void>) {
  await runWithWorkspace(`summary-pagination-${process.pid}-${++sequence}`, async () => {
    const { persona } = await createPersonaFromRole({ name: 'Pagination template' });
    for (const id of ['persona_a_lower', 'persona_B_upper', 'persona_z_lower', 'persona_Y_upper', 'persona_-x', 'persona__x']) {
      await createPersona({ ...persona, id, name: id, factoryKeyHash: undefined });
    }
    await task((await listPersonas()).map(item => item.id));
  });
}

it('visits every mixed-case Persona exactly once and reaches the end', async () => {
  await withMixedCasePersonas(async expected => {
    const visited: string[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    for (let page = 0; page < expected.length && hasMore; page++) {
      const result = await listPersonaSummaries({ pageSize: 1, cursor });
      visited.push(...result.items.map(item => item.id));
      cursor = result.nextCursor;
      hasMore = result.hasMore;
    }
    expect(visited).toEqual(expected);
    expect(hasMore).toBe(false);
    expect(cursor).toBeNull();
  });
});

it('continues past a removed boundary record using the same ordering as the store', async () => {
  await withMixedCasePersonas(async expected => {
    const boundaryIndex = expected.indexOf('persona_B_upper');
    const first = await listPersonaSummaries({ pageSize: boundaryIndex + 1 });
    expect(first.items.at(-1)?.id).toBe('persona_B_upper');
    await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, 'persona_B_upper');
    const remaining = await listPersonaSummaries({ pageSize: 100, cursor: first.nextCursor });
    expect(remaining.items.map(item => item.id)).toEqual(expected.slice(boundaryIndex + 1));
    expect(remaining.hasMore).toBe(false);
    expect(remaining.nextCursor).toBeNull();
  });
});
