// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { Flow, FlowNode, HistoryEntry } from '@/shared/types/flow';
import { 
  FlowServiceResponse, 
  FlowOperationResponse, 
  FlowListResponse
} from '@/shared/types/flow';
import {
  saveCollectionItem,
  loadCollectionItem,
  deleteCollectionItem,
  listCollectionItemsWithStats,
  assertSafeCollectionId,
  migrateArrayFileToCollection,
} from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Edge } from '@xyflow/react';
import { createLogger } from '@/utils/logger';
import {
  archiveFlowVersion,
  listFlowVersions,
  getFlowVersion,
  wipeFlowVersions,
  FlowVersionRecord,
  FlowVersionSummary,
} from './flowVersions';

const log = createLogger('backend/services/flow/index');

// The flows snapshot is global-backed so every module instance shares ONE cache.
// In production (`next start`) the module instance that runs the scheduler/startup
// hook is NOT the one serving the Flow Builder / API routes; a plain per-instance
// field let the scheduler read a stale snapshot that predated a newly-created flow,
// so getFlow() returned null and the engine threw `Flow not found: <id>` on
// scheduled runs even though manual chat runs (fresh cache in that instance)
// worked. Same reasoning as SchedulerService's `global.__flujo_scheduler` and the
// MCP service's global recovery maps.
declare global {
  // eslint-disable-next-line no-var
  var __flujo_flowsCache: Flow[] | null | undefined;
  // One-shot promise guarding the legacy-file -> per-flow-file migration so it
  // runs at most once per process (idempotent even if it somehow ran twice).
  // eslint-disable-next-line no-var
  var __flujo_flowsMigration: Promise<void> | undefined;
}

// Flows are stored one file per flow under db/flows/<id>.json (the legacy layout
// was a single db/flows.json array, migrated on first access). StorageKey.FLOWS
// ('flows') doubles as the collection directory name and the legacy file's key.
const FLOWS_COLLECTION: string = StorageKey.FLOWS;

// Serialize a flow's *content* (everything except the server-managed
// createdAt/updatedAt) for the version-archiving no-op check, so refreshing a
// timestamp on save is never mistaken for a real edit (#108).
function stripTimestamps(flow: Flow): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = flow;
  return JSON.stringify(rest);
}

// Run the one-time migration from the legacy single-file array to per-flow
// files. Guarded by a global promise so concurrent callers share one run; on
// failure the guard is cleared so a later call can retry (the migration is
// idempotent, so retrying is safe).
async function ensureFlowsMigrated(): Promise<void> {
  if (!global.__flujo_flowsMigration) {
    global.__flujo_flowsMigration = (async () => {
      try {
        await migrateArrayFileToCollection<Flow>(StorageKey.FLOWS, FLOWS_COLLECTION, (f) => f.id);
      } catch (error) {
        log.error('Flow storage migration failed', error);
        global.__flujo_flowsMigration = undefined;
      }
    })();
  }
  return global.__flujo_flowsMigration;
}

/**
 * FlowService class provides a clean interface for flow-related operations
 * This is the core backend service that handles all flow operations
 */
export class FlowService { // Add export keyword here
  private get flowsCache(): Flow[] | null {
    return global.__flujo_flowsCache ?? null;
  }
  private set flowsCache(value: Flow[] | null) {
    global.__flujo_flowsCache = value;
  }

  /**
   * Load all flows from storage
   */
  async loadFlows(): Promise<Flow[]> {
    try {
      // Try to use cache first
      if (this.flowsCache) {
        log.debug('Using cached flows');
        return this.flowsCache;
      }

      log.debug('Loading flows from storage');
      await ensureFlowsMigrated();
      // Backfill server-managed timestamps for legacy flows (#108): flows saved
      // before createdAt/updatedAt existed have neither, so derive them from the
      // file's mtime (mirroring the conversations route). Read-only/in-memory —
      // the next real save persists the values; files are not rewritten here.
      const raw = await listCollectionItemsWithStats<Flow>(FLOWS_COLLECTION);
      const flows = raw.map(({ item, mtimeMs }) => {
        if (item.createdAt != null && item.updatedAt != null) return item;
        const ts = Math.floor(mtimeMs);
        return {
          ...item,
          createdAt: item.createdAt ?? ts,
          updatedAt: item.updatedAt ?? ts,
        };
      });
      this.flowsCache = flows;
      log.info('Loaded flows from storage', { count: flows.length });
      return flows;
    } catch (error) {
      log.error('Failed to load flows', error);
      return [];
    }
  }

  /**
   * Get a specific flow by ID
   */
  async getFlow(flowId: string): Promise<Flow | null> {
    try {
      log.debug(`Getting flow by ID: ${flowId}`);

      // Cache hit first.
      const cached = this.flowsCache?.find(f => f.id === flowId) || null;
      if (cached) {
        log.debug(`Flow ${flowId} found in cache`);
        return cached;
      }

      // Cache miss (or empty cache): read just this one file instead of the
      // whole collection. This is both cheaper than the old full re-read and
      // the safety net for the multi-instance case where another module
      // instance created the flow after this instance's cache was built (the
      // `Flow not found: <id>` scheduled-run failures).
      await ensureFlowsMigrated();
      let flow: Flow | null = null;
      try {
        flow = await loadCollectionItem<Flow | null>(FLOWS_COLLECTION, flowId, null);
      } catch (error) {
        // Unsafe id or an unreadable file: treat as not found rather than throw.
        log.debug(`getFlow: could not load flow ${flowId}`, error);
        flow = null;
      }

      // Refresh the shared cache entry, but only when a cache already exists —
      // never build a partial one-item cache that loadFlows would then trust.
      if (flow && this.flowsCache) {
        const cache = this.flowsCache;
        const idx = cache.findIndex(f => f.id === flow!.id);
        if (idx >= 0) cache[idx] = flow; else cache.push(flow);
        this.flowsCache = cache;
      }

      log.debug(`Flow ${flowId} ${flow ? 'found' : 'not found'}`);
      return flow;
    } catch (error) {
      log.error(`Failed to get flow ${flowId}`, error);
      return null;
    }
  }

  /**
   * Invalidate the execution engine's compiled-flow cache for a flow (or all
   * flows when no id is given). Uses a lazy import so this service does not
   * statically depend on the execution layer, which depends back on it.
   */
  private async invalidateExecutionCache(flowId?: string): Promise<void> {
    try {
      const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
      FlowExecutor.clearFlowCache(flowId);
      log.debug(`Invalidated execution flow cache`, { flowId: flowId ?? 'all' });
    } catch (error) {
      log.warn('Failed to invalidate execution flow cache', error);
    }
  }

  /**
   * Save a flow (create new or update existing)
   */
  async saveFlow(flow: Flow): Promise<FlowServiceResponse> {
    try {
      log.debug(`Saving flow: ${flow.id}`, { name: flow.name });
      // Validate the id before it is used as a file name (path-traversal guard).
      assertSafeCollectionId(flow.id);
      await ensureFlowsMigrated();

      // Version history: when this save OVERWRITES an existing flow, archive
      // the definition being replaced (skipping no-op saves). Best-effort —
      // a save must never fail because history could not be written.
      let previous: Flow | null = null;
      try {
        previous = await loadCollectionItem<Flow | null>(FLOWS_COLLECTION, flow.id, null);
      } catch (error) {
        log.debug(`saveFlow: could not read previous definition of ${flow.id} for versioning`, error);
      }
      // Compare content ONLY (excluding the server-managed timestamps), so a
      // save that merely refreshes updatedAt is not treated as a real edit and
      // does not archive a spurious version.
      if (previous && stripTimestamps(previous) !== stripTimestamps(flow)) {
        await archiveFlowVersion(previous);
      }

      // Stamp server-managed timestamps (#108) authoritatively, so a client
      // cannot forge them: createdAt is set once and preserved across saves;
      // updatedAt is refreshed on every write. Mutating `flow` in place means
      // the API routes (which return this object) hand the stamped values back
      // to the caller/cache.
      const now = Date.now();
      flow.createdAt = previous?.createdAt ?? flow.createdAt ?? now;
      flow.updatedAt = now;

      // Write only this flow's file (no whole-collection rewrite).
      await saveCollectionItem(FLOWS_COLLECTION, flow.id, flow);

      // Patch the shared cache in place when it exists; leave it null otherwise
      // so the next loadFlows reads the full set from disk (never build a
      // partial cache here).
      const cache = this.flowsCache;
      if (cache) {
        const idx = cache.findIndex(f => f.id === flow.id);
        if (idx >= 0) cache[idx] = flow; else cache.push(flow);
        this.flowsCache = cache;
      }

      // Invalidate the execution engine's compiled-flow cache for this flow so
      // a subsequent run picks up the edit (renamed nodes/models, new edges,
      // etc.). Without this the engine keeps using the stale compiled flow until
      // the process restarts. Lazy import to avoid a static circular dependency
      // (FlowExecutor → PocketflowEngine → this flowService).
      await this.invalidateExecutionCache(flow.id);

      log.info(`Flow ${flow.id} saved successfully`);
      return { success: true };
    } catch (error) {
      log.error('Failed to save flow', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to save flow' 
      };
    }
  }

  /**
   * Delete a flow by ID
   */
  async deleteFlow(flowId: string): Promise<FlowServiceResponse> {
    try {
      log.debug(`Deleting flow: ${flowId}`);
      await ensureFlowsMigrated();

      // Remove only this flow's file.
      await deleteCollectionItem(FLOWS_COLLECTION, flowId);

      // Drop it from the shared cache when one exists.
      const cache = this.flowsCache;
      if (cache) {
        this.flowsCache = cache.filter(flow => flow.id !== flowId);
      }

      // Drop any compiled copy of the deleted flow from the execution engine.
      await this.invalidateExecutionCache(flowId);

      // A deleted flow's version history goes with it (best-effort).
      await wipeFlowVersions(flowId);

      log.info(`Flow ${flowId} deleted successfully`);
      return { success: true };
    } catch (error) {
      log.error(`Failed to delete flow: ${flowId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete flow'
      };
    }
  }

  /** Archived (superseded) versions of a flow, newest first. */
  async listFlowVersions(flowId: string): Promise<FlowVersionSummary[]> {
    return listFlowVersions(flowId);
  }

  /** One archived version with its full definition, or null. */
  async getFlowVersion(flowId: string, versionId: string): Promise<FlowVersionRecord | null> {
    return getFlowVersion(flowId, versionId);
  }

  /**
   * Restore an archived version as the flow's current definition. Goes through
   * saveFlow, so the definition being reverted AWAY from is archived first —
   * a revert is itself reversible.
   */
  async revertFlow(flowId: string, versionId: string): Promise<FlowServiceResponse> {
    const record = await getFlowVersion(flowId, versionId);
    if (!record) {
      return { success: false, error: `No version "${versionId}" of flow ${flowId}` };
    }
    // The id is pinned to the live flow id (defensive — records store it too).
    return this.saveFlow({ ...record.flow, id: flowId });
  }

  /**
   * Create a new node of the specified type at the given position
   */
  createNode(type: string, position: { x: number; y: number }): FlowNode {
    log.debug(`Creating new node of type: ${type}`, { position });
    const node = {
      id: uuidv4(),
      type,
      position,
      data: {
        label: `${type === 'mcp' ? 'MCP' : type.charAt(0).toUpperCase() + type.slice(1)} Node`,
        type,
        properties: {},
      },
    };
    log.debug(`Node created with ID: ${node.id}`);
    return node;
  }

  /**
   * Create a new flow with a default Start node
   */
  createNewFlow(name: string = 'NewFlow'): Flow {
    log.debug(`Creating new flow: ${name}`);
    // Create a Start node
    const startNode: FlowNode = {
      id: uuidv4(),
      type: 'start',
      position: { x: 250, y: 150 },
      data: { 
        label: 'Start Node', 
        type: 'start',
        properties: {
          promptTemplate: ''
        }
      }
    };
    
    // Create and return the new flow. createdAt/updatedAt are sensible defaults
    // for the in-memory draft; saveFlow re-stamps them authoritatively (#108).
    const now = Date.now();
    const flow = {
      id: uuidv4(),
      name,
      createdAt: now,
      updatedAt: now,
      nodes: [startNode],
      edges: [],
    };
    
    log.info(`New flow created with ID: ${flow.id}`, { name });
    return flow;
  }

  /**
   * Create a history entry for undo/redo functionality
   */
  createHistoryEntry(nodes: FlowNode[], edges: Edge[]): HistoryEntry {
    log.debug('Creating history entry', { nodeCount: nodes.length, edgeCount: edges.length });
    return {
      nodes: [...nodes],
      edges: [...edges]
    };
  }

  /**
   * Generate sample flow data for testing
   */
  generateSampleFlow(name: string = 'Sample Flow'): Flow {
    log.debug(`Generating sample flow: ${name}`);
    const sampleNodes: FlowNode[] = [
      {
        id: '1',
        type: 'start',
        position: { x: 250, y: 50 },
        data: { 
          label: 'Start Node', 
          type: 'start',
          properties: {
            prompt: 'Enter your query here',
            systemMessage: 'You are a helpful assistant',
            temperature: 0.0
          }
        }
      },
      {
        id: '2',
        type: 'process',
        position: { x: 250, y: 200 },
        data: { 
          label: 'Process Node', 
          type: 'process',
          properties: {
            operation: 'transform',
            enabled: true
          }
        }
      },
      {
        id: '3',
        type: 'finish',
        position: { x: 250, y: 350 },
        data: { 
          label: 'Finish Node', 
          type: 'finish',
          properties: {
            format: 'json',
            template: '{ "result": {{data}} }'
          }
        }
      },
      {
        id: '4',
        type: 'mcp',
        position: { x: 450, y: 200 },
        data: { 
          label: 'MCP Node', 
          type: 'mcp',
          properties: {
            channels: 2,
            mode: 'parallel'
          }
        }
      }
    ];
    
    const sampleEdges: Edge[] = [
      {
        id: 'e1-2',
        source: '1',
        target: '2',
        type: 'custom'
      },
      {
        id: 'e2-3',
        source: '2',
        target: '3',
        type: 'custom'
      }
    ];
    
    const flow = {
      id: uuidv4(),
      name,
      nodes: sampleNodes,
      edges: sampleEdges,
    };
    
    log.info(`Sample flow generated with ID: ${flow.id}`, { name });
    return flow;
  }

  /**
   * List all flows
   */
  async listFlows(): Promise<FlowListResponse> {
    log.debug('listFlows: Entering method');
    try {
      const flows = await this.loadFlows();
      return { success: true, flows };
    } catch (error) {
      log.warn('listFlows: Failed to list flows:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list flows'
      };
    }
  }
}

// Export a singleton instance of the service
export const flowService = new FlowService();
