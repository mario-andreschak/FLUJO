/**
 * Property-based checks for the conversation log writer's append and rollback
 * (issue #1424), against a real file with injected disk faults.
 *
 * Each generated history starts from earlier events, optionally ending in a
 * torn line left by a crash, and then runs saves that may fail part-way, fail
 * at sync, fail to roll back, or be rolled back on purpose. After every save:
 *
 * - a failed or rolled-back save leaves the file exactly as it was;
 * - a successful save adds exactly its own lines, on a fresh line after a torn tail;
 * - a save whose rollback failed keeps only a prefix of its own bytes;
 * - no earlier event is ever changed, lost or duplicated, and order is kept.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { withConversationLogWriter } from '@/backend/execution/flow/conversationPublicationIO';
import { getConversationPublicationDiagnostics, publishConversation } from '@/backend/execution/flow/conversationPublication';

jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({
  withWorkspaceMutation: async (task: () => Promise<unknown>) => task(), assertWorkspaceMutationOwned: async () => {},
}));
jest.mock('@/backend/services/security/bundledFlujoWorkload', () => ({ assertBundledFlujoWorkloadEffectCurrent: async () => {} }));

type Fault = 'none' | 'write' | 'sync' | 'rollbackFails';
type Save = { ids: number; fault: Fault; cut: number; rollback: boolean };
type Outcome = 'kept' | 'rolledBack' | 'failedCleanly' | 'uncertain';

const injected = () => Object.assign(new Error('injected disk failure'), { code: 'EIO' });
const event = (id: string, content: string) => ({ type: 'message', conversationId: 'property', seq: 0, timestamp: 1,
  message: { id, role: 'user', content } });
const line = (id: string) => `${JSON.stringify(event(id, `content of ${id}`))}\n`;
/** Ids carried by complete, parseable lines, in file order. A torn line is skipped, as readers do. */
const idsIn = (text: string) => text.split('\n').flatMap(entry => {
  try { return [JSON.parse(entry).message.id as string]; } catch { return []; }
});

const save = fc.record({
  ids: fc.integer({ min: 1, max: 3 }),
  fault: fc.constantFrom<Fault>('none', 'none', 'write', 'sync', 'rollbackFails'),
  cut: fc.nat({ max: 400 }),
  rollback: fc.boolean(),
});

let directory: string;
let run = 0;
const open = fs.open.bind(fs);
beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-log-property-')); });
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function checkHistory(priorCount: number, tornAt: number | undefined, plans: Save[]) {
  const file = path.join(directory, `run-${run++}.jsonl`);
  const prior = Array.from({ length: priorCount }, (_, index) => `prior-${index}`);
  const torn = tornAt === undefined ? '' : line('torn').slice(0, 1 + tornAt % (line('torn').length - 2));
  await fs.writeFile(file, prior.map(line).join('') + torn);

  // Fault injection on the log file's descriptor only.
  const fault = { kind: 'none' as Fault, cut: 0, written: 0, triggered: false };
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== file) return handle;
    const write = handle.write.bind(handle), sync = handle.sync.bind(handle), truncate = handle.truncate.bind(handle);
    jest.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
      if ((fault.kind === 'write' || fault.kind === 'rollbackFails') && !fault.triggered && fault.written + length > fault.cut) {
        fault.triggered = true;
        if (fault.cut > fault.written) await write(buffer, offset, fault.cut - fault.written, position);
        throw injected();
      }
      const result = await write(buffer, offset, length, position);
      fault.written += result.bytesWritten;
      return result;
    }) as typeof handle.write);
    jest.spyOn(handle, 'sync').mockImplementation(async () => {
      if (fault.kind === 'sync' && !fault.triggered) { fault.triggered = true; throw injected(); }
      return sync();
    });
    jest.spyOn(handle, 'truncate').mockImplementation(async (length?: number) => {
      if (fault.kind === 'rollbackFails' && fault.triggered) throw injected();
      return truncate(length);
    });
    return handle;
  });

  const expectedIds = [...prior];
  let next = 0;
  for (const plan of plans) {
    const ids = Array.from({ length: plan.ids }, () => `save-${next++}`);
    const before = await fs.readFile(file, 'utf8');
    const intended = (before && !before.endsWith('\n') ? '\n' : '') + ids.map(line).join('');
    Object.assign(fault, { kind: plan.fault, cut: plan.cut, written: 0, triggered: false });
    let outcome: Outcome = 'kept';
    await publishConversation('property', null, () => withConversationLogWriter(file, async writer => {
      try {
        await writer.append(ids.map(id => event(id, `content of ${id}`)));
      } catch (error) {
        outcome = (error as { code?: string }).code === 'CONVERSATION_PUBLICATION_UNCERTAIN' ? 'uncertain' : 'failedCleanly';
        return;
      }
      if (plan.rollback) { await writer.rollback(); outcome = 'rolledBack'; }
    }));
    const after = await fs.readFile(file, 'utf8');
    if (outcome === 'kept') {
      expect(after).toBe(before + intended);
      expectedIds.push(...ids);
    } else if (outcome === 'uncertain') {
      // Only a rollback that itself failed may leave the outcome unknown.
      expect(plan.fault).toBe('rollbackFails');
      // Only bytes of its own append remain; earlier bytes are untouched.
      expect(after.startsWith(before)).toBe(true);
      expect(intended.startsWith(after.slice(before.length))).toBe(true);
      expectedIds.push(...idsIn(after.slice(before.length)));
    } else {
      expect(after).toBe(before);
    }
  }
  // Every kept event is readable once, in order, after the earlier ones.
  expect(idsIn(await fs.readFile(file, 'utf8'))).toEqual(expectedIds);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 0, quarantinedWriterSlots: 0, chains: 0 });
}

// Every save syncs a real file to disk, so this suite gets a longer limit.
it('appends exactly its own lines, rolls back to the exact prior bytes and never touches earlier events', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 3 }), fc.option(fc.nat({ max: 60 }), { nil: undefined }), fc.array(save, { minLength: 1, maxLength: 5 }),
    async (priorCount, tornAt, plans) => {
      try { await checkHistory(priorCount, tornAt, plans); } finally { jest.restoreAllMocks(); }
    }), { numRuns: 40 });
}, 120_000);
