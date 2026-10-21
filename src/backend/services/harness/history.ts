import { listCollectionItemEntriesStrict, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { normalizeHarnessTask, type HarnessRun } from '@/shared/types/harness';
import { harnessDigest } from './executionScope';

const INDEX = 'harness-run-index';
const TASKS = 'harness-task-ledger';
export interface HarnessRunSummary {
  schemaVersion: 1;
  id: string;
  name: string;
  domain: string;
  status: HarnessRun['status'];
  createdAt: number;
  callsCompleted: number;
  eligible: boolean;
  promotedPromptHash?: string;
  lesson?: string;
  lessonScope?: string;
  modelFingerprint: string;
}
export async function indexHarnessRun(run: HarnessRun) {
  const row: HarnessRunSummary = { schemaVersion: 1, id: run.id, name: run.input.name, domain: run.input.domain,
    status: run.status, createdAt: run.createdAt, callsCompleted: run.callsCompleted, eligible: run.decision?.eligible === true,
    promotedPromptHash: run.promotedPromptHash, lesson: run.lesson, lessonScope: run.lessonScope, modelFingerprint: run.modelFingerprint };
  await saveCollectionItem(INDEX, run.id, row);
}
export async function hasSeenHarnessTask(input: string): Promise<boolean> {
  return (await loadCollectionItem(TASKS, harnessDigest(normalizeHarnessTask(input)), null)) !== null;
}
/** Reserve before experiment creation: a crash can consume a task, never make a holdout fresh again. */
export async function reserveHarnessTasks(run: Pick<HarnessRun, 'id' | 'input'>) {
  for (const item of run.input.cases) {
    const id = harnessDigest(normalizeHarnessTask(item.input));
    if (!(await loadCollectionItem(TASKS, id, null))) await saveCollectionItem(TASKS, id, { experimentId: run.id });
  }
}
/** Called under harness-create. Existing evidence is read once, without dropping historical holdouts. */
export async function initializeHarnessHistory(readLegacy: () => Promise<HarnessRun[]>) {
  const ready = await loadCollectionItem<{ version: number } | null>('harness-index-state', 'ready', null);
  if (ready?.version === 1) return;
  if (ready) throw new Error('Unsupported Harness history index.');
  for (const run of await readLegacy()) {
    await reserveHarnessTasks(run);
    await indexHarnessRun(run);
  }
  await saveCollectionItem('harness-index-state', 'ready', { version: 1 });
}
export async function readHarnessSummaries(): Promise<HarnessRunSummary[]> {
  const rows = await listCollectionItemEntriesStrict<HarnessRunSummary>(INDEX);
  for (const row of rows) if (!row.item || row.item.id !== row.id || row.item.schemaVersion !== 1) throw new Error('Invalid Harness history index.');
  return rows.map(row => row.item).sort((a, b) => b.createdAt - a.createdAt);
}
