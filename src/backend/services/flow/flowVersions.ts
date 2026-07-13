/**
 * Persistent flow version history: every time an EXISTING flow is overwritten
 * (builder save, update_flow, revert), the superseded definition is archived to
 * db/flow-versions/<flowId>/<versionId>.json before it is lost, capped at the
 * most recent MAX_VERSIONS_PER_FLOW entries. This is what makes update_flow's
 * full-replace semantics safe to hand to a model: any replaced definition can
 * be inspected (read_flow_version) and restored (revert_flow) — and because a
 * revert goes through saveFlow, the reverted-away definition is archived too,
 * so jumping back is itself reversible.
 *
 * Storage piggybacks on the collection helpers (atomic writes, safe-id guard):
 * the collection name is `flow-versions/<flowId>`, which nests one directory
 * per flow under db/. Archiving is best-effort by contract — callers must
 * never fail a save because history could not be written.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { Flow } from '@/shared/types/flow';
import {
  saveCollectionItem,
  loadCollectionItem,
  deleteCollectionItem,
  listCollectionItems,
  assertSafeCollectionId,
} from '@/utils/storage/backend';
import { getDataDir } from '@/utils/paths';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/flow/flowVersions');

export interface FlowVersionRecord {
  versionId: string;
  flowId: string;
  /** When the version was archived (= when it was superseded), ms epoch. */
  savedAt: number;
  /** The complete superseded definition. */
  flow: Flow;
}

export interface FlowVersionSummary {
  versionId: string;
  savedAt: number;
  name: string;
  nodeCount: number;
  edgeCount: number;
}

export const MAX_VERSIONS_PER_FLOW = 25;

function versionsCollection(flowId: string): string {
  // The flowId becomes a directory segment — hold it to the same safe-id rule
  // as collection item ids (path-traversal guard).
  assertSafeCollectionId(flowId);
  return `flow-versions/${flowId}`;
}

/** Sortable id: ms timestamp (fixed 13 digits until 2286) + collision suffix. */
function newVersionId(savedAt: number): string {
  return `${savedAt}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Archive a superseded flow definition. Returns the new version id, or null
 * when archiving failed (best-effort — never throws).
 */
export async function archiveFlowVersion(previous: Flow): Promise<string | null> {
  try {
    const collection = versionsCollection(previous.id);
    const savedAt = Date.now();
    const versionId = newVersionId(savedAt);
    const record: FlowVersionRecord = { versionId, flowId: previous.id, savedAt, flow: previous };
    await saveCollectionItem(collection, versionId, record);
    await pruneOldVersions(previous.id);
    return versionId;
  } catch (error) {
    log.warn(`Could not archive a version of flow ${previous.id}`, error);
    return null;
  }
}

async function pruneOldVersions(flowId: string): Promise<void> {
  const collection = versionsCollection(flowId);
  const records = await listCollectionItems<FlowVersionRecord>(collection);
  if (records.length <= MAX_VERSIONS_PER_FLOW) return;
  const excess = records
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(MAX_VERSIONS_PER_FLOW);
  for (const record of excess) {
    try {
      await deleteCollectionItem(collection, record.versionId);
    } catch (error) {
      log.warn(`Could not prune version ${record.versionId} of flow ${flowId}`, error);
    }
  }
}

/** Version summaries for a flow, newest first. Empty when there is no history. */
export async function listFlowVersions(flowId: string): Promise<FlowVersionSummary[]> {
  const records = await listCollectionItems<FlowVersionRecord>(versionsCollection(flowId));
  return records
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((r) => ({
      versionId: r.versionId,
      savedAt: r.savedAt,
      name: r.flow?.name ?? 'unknown',
      nodeCount: r.flow?.nodes?.length ?? 0,
      edgeCount: r.flow?.edges?.length ?? 0,
    }));
}

export async function getFlowVersion(flowId: string, versionId: string): Promise<FlowVersionRecord | null> {
  try {
    return await loadCollectionItem<FlowVersionRecord | null>(versionsCollection(flowId), versionId, null);
  } catch (error) {
    log.debug(`getFlowVersion: could not load ${flowId}/${versionId}`, error);
    return null;
  }
}

/** Remove a flow's entire version history (used when the flow is deleted). Best-effort. */
export async function wipeFlowVersions(flowId: string): Promise<void> {
  try {
    assertSafeCollectionId(flowId);
    await fs.rm(path.join(getDataDir(), 'db', 'flow-versions', flowId), { recursive: true, force: true });
  } catch (error) {
    log.warn(`Could not remove version history of flow ${flowId}`, error);
  }
}
