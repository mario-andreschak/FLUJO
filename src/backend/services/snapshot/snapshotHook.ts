/**
 * Executor-side glue for filesystem snapshots (issue #250).
 *
 * FlowExecutor.executeStep calls `captureBefore()` just before a Process node
 * runs and `captureAfterAndEmit()` just after, when that node has the built-in
 * `filesystem` / `bash` servers armed. Both are BEST-EFFORT and never throw —
 * a snapshot failure must never abort a run.
 *
 * "Armed" is detected from the COMPILED flow: FlowConverter folds every bound
 * MCP node onto the Process node's `node_params.properties.mcpNodes` (each with
 * a `boundServer`), so we can decide at `node:enter` — before the node runs —
 * without relying on `sharedState.currentMCPNodes`, which ProcessNode.prep only
 * populates later.
 */
import { createLogger } from '@/utils/logger';
import { ResolvedNode } from '@/backend/execution/flow/engine/FlowEngine';
import { SharedState } from '@/backend/execution/flow/types';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import { writeRunResource } from '@/backend/services/runResources';
import { shadowRepoService } from './ShadowRepoService';

const log = createLogger('backend/services/snapshot/snapshotHook');

export interface SnapshotContext {
  /** Confinement roots being watched for this Process-node visit. */
  roots: string[];
  /** root → start-snapshot SHA (or null when capture was disabled/failed). */
  start: Map<string, string | null>;
}

/** Read the servers armed on the compiled Process node (opaque handle probe). */
function armedServers(node: ResolvedNode): Set<string> {
  const servers = new Set<string>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpNodes = (node as any)?.handle?.node_params?.properties?.mcpNodes;
    if (!Array.isArray(mcpNodes)) return servers;
    for (const m of mcpNodes) {
      const s = m?.properties?.boundServer;
      if (s === 'filesystem' || s === 'bash') servers.add(s);
    }
  } catch (err) {
    log.debug('armedServers probe failed', { err });
  }
  return servers;
}

/** Resolve the confinement roots to watch for the armed servers. */
async function resolveArmedRoots(node: ResolvedNode): Promise<string[]> {
  const servers = armedServers(node);
  if (servers.size === 0) return [];
  const { loadEffectiveRoots } = await import('@/backend/services/mcp/internal/confinement');
  const roots = new Set<string>();
  try {
    if (servers.has('filesystem')) {
      for (const r of await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS')) roots.add(r);
    }
    if (servers.has('bash')) {
      for (const r of await loadEffectiveRoots('bash', ['FLUJO_BASH_ROOTS', 'FLUJO_FS_ROOTS'])) roots.add(r);
    }
  } catch (err) {
    log.warn('resolveArmedRoots failed', { err });
  }
  return [...roots];
}

function nodeRef(node: ResolvedNode): NodeRef {
  return { nodeId: node.id, nodeName: node.name, nodeType: node.type };
}

/**
 * Take the START snapshot for an armed Process node. Returns null when there is
 * nothing to snapshot (not a process node, ephemeral run, no armed fs/bash
 * server, or no git-repo root). Never throws.
 */
export async function captureBefore(
  node: ResolvedNode,
  sharedState: SharedState,
  emit?: EmitFn
): Promise<SnapshotContext | null> {
  try {
    if (node.type !== 'process') return null;
    if (sharedState.ephemeral) return null;
    const roots = await resolveArmedRoots(node);
    if (roots.length === 0) return null;

    const start = new Map<string, string | null>();
    for (const root of roots) {
      const sha = await shadowRepoService.capture(root);
      start.set(root, sha);
      if (sha) {
        emit?.({ type: 'node:snapshot', node: nodeRef(node), phase: 'before', root, snapshotId: sha });
      }
    }
    // Only keep a context if at least one root actually produced a snapshot.
    const anyCaptured = [...start.values()].some((v) => !!v);
    return anyCaptured ? { roots, start } : null;
  } catch (err) {
    log.warn('captureBefore failed — no snapshot for this node', { err });
    return null;
  }
}

/**
 * Take the END snapshot, compute the per-root changed files, and emit
 * `node:snapshot` (after) + `node:changed-files` events. Never throws.
 */
export async function captureAfterAndEmit(
  node: ResolvedNode,
  ctx: SnapshotContext | null,
  sharedState: SharedState,
  emit?: EmitFn
): Promise<void> {
  if (!ctx) return;
  try {
    for (const root of ctx.roots) {
      const startSha = ctx.start.get(root) || null;
      const endSha = await shadowRepoService.capture(root);
      if (endSha) {
        emit?.({ type: 'node:snapshot', node: nodeRef(node), phase: 'after', root, snapshotId: endSha });
      }
      if (startSha && endSha) {
        const changedFiles = await shadowRepoService.files(root, startSha, endSha);
        if (changedFiles.length > 0) {
          let patchResourceUri: string | undefined;
          const conversationId = sharedState.conversationId;
          if (conversationId) {
            try {
              const patch = await shadowRepoService.diff(root, startSha, endSha);
              if (patch.trim().length > 0) {
                const written = await writeRunResource({
                  conversationId,
                  kind: 'text',
                  mimeType: 'text/x-patch',
                  data: { text: patch },
                  producedBy: {
                    source: 'snapshot',
                    nodeId: node.id,
                    nodeName: node.name,
                  },
                });
                if (!('skipped' in written)) {
                  patchResourceUri = written.uri;
                  emit?.({
                    type: 'resource:write',
                    node: nodeRef(node),
                    server: 'flujo',
                    uri: written.uri,
                    name: written.name,
                    mimeType: written.mimeType,
                    size: written.size,
                    source: 'snapshot',
                    snapshot: {
                      root,
                      startSnapshot: startSha,
                      endSnapshot: endSha,
                      changedFiles,
                    },
                  });
                }
              }
            } catch (err) {
              log.warn('Snapshot patch persistence failed', { root, err });
            }
          }
          emit?.({
            type: 'node:changed-files',
            node: nodeRef(node),
            root,
            startSnapshot: startSha,
            endSnapshot: endSha,
            changedFiles,
            patchResourceUri,
          });
        }
      }
    }
  } catch (err) {
    log.warn('captureAfterAndEmit failed', { err });
  }
}
