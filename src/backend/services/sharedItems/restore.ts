import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { SHARED_ITEM_LABELS, type SharedItemKind } from './kinds';
import { getHistoryEntry, type HistoryEntry } from './history';
import { recordChange, type SharedEditor } from './guard';
import { loadSharedItem } from './load';
import { restoreSecrets } from './secrets';

/**
 * Bring back an older version of a flow, model or MCP server (#575, step
 * 575-3). A restore is a new save: the version being replaced stays in the
 * history (and, for flows, in the flow's own version list), so a restore can
 * itself be undone.
 *
 * History snapshots hold no secrets. Every masked value takes the value stored
 * now at the same place, and the save paths read a remaining `********` as
 * "keep the stored secret", so a restore changes settings but never a key.
 */

export class RestoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'RestoreError';
    this.status = status;
    this.code = code;
  }
}

export interface RestoreResult {
  /** The item as stored after the restore. */
  readonly item: unknown;
  /** The new history entry (`null` only if history could not be written; the restore itself was saved). */
  readonly entry: HistoryEntry | null;
}

function failure(kind: SharedItemKind, message: string | undefined): RestoreError {
  return new RestoreError(
    `The older version of this ${SHARED_ITEM_LABELS[kind]} could not be saved${message ? `: ${message}` : '.'}`,
    400,
    'RESTORE_FAILED',
  );
}

async function saveFlowVersion(itemId: string, merged: object, current: Record<string, unknown> | null): Promise<unknown> {
  const currentUpdatedAt = current?.updatedAt;
  const currentOwnership = (current as Pick<Flow, 'personaOwnership'> | null)?.personaOwnership;
  const flow: Flow = {
    ...(merged as Flow),
    id: itemId,
    // Ownership is server-authored; a restore never moves a flow to or from a Persona.
    personaOwnership: currentOwnership,
  };
  const result = await flowService.saveFlow(flow, typeof currentUpdatedAt === 'number'
    ? { expectedUpdatedAt: currentUpdatedAt } : {});
  if (!result.success) {
    if (result.error === 'Flow changed since inspection.') {
      throw new RestoreError('Someone saved this flow just now. Look at the newest version and try again.', 409, 'EDIT_CONFLICT');
    }
    throw failure('flow', result.error);
  }
  return flow;
}

async function saveModelVersion(itemId: string, merged: object, current: Record<string, unknown> | null): Promise<unknown> {
  const model: Model = { ...(merged as Model), id: itemId };
  const result = current ? await modelService.updateModel(model) : await modelService.addModel(model);
  if (!result.success) throw failure('model', result.error);
  return loadSharedItem('model', itemId);
}

async function saveMcpVersion(itemId: string, merged: object): Promise<unknown> {
  const config: MCPServerConfig = { ...(merged as MCPServerConfig), name: itemId };
  const result = await mcpService.updateServerConfig(itemId, config);
  if ('error' in result && result.error) throw failure('mcp-server', String(result.error));
  return loadSharedItem('mcp-server', itemId);
}

/**
 * Restore `entryId` of an item as its newest version, for `editor`. The caller
 * checked access (workspace `edit`) and the base version.
 */
export async function restoreHistoryEntry(editor: SharedEditor, kind: SharedItemKind, itemId: string,
  entryId: string): Promise<RestoreResult> {
  const entry = await getHistoryEntry(kind, itemId, entryId);
  if (!entry || entry.snapshot === null || typeof entry.snapshot !== 'object' || Array.isArray(entry.snapshot)) {
    throw new RestoreError('That version is no longer in the history.', 404, 'HISTORY_ENTRY_NOT_FOUND');
  }
  const current = await loadSharedItem(kind, itemId);
  const restored = restoreSecrets(entry.snapshot, current ?? undefined);
  if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
    throw new RestoreError('That version is no longer in the history.', 404, 'HISTORY_ENTRY_NOT_FOUND');
  }
  const merged: object = restored;
  let item: unknown;
  switch (kind) {
    case 'flow':
      item = await saveFlowVersion(itemId, merged, current);
      break;
    case 'model':
      item = await saveModelVersion(itemId, merged, current);
      break;
    case 'mcp-server':
      item = await saveMcpVersion(itemId, merged);
      break;
  }
  const recorded = await recordChange(editor, {
    kind, itemId, action: 'restored', before: current, after: item, restoredFrom: entry.entryId,
  });
  return { item, entry: recorded };
}
