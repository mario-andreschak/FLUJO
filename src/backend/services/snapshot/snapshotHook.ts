/**
 * Executor-side glue for filesystem snapshots (issue #250).
 *
 * FlowExecutor.executeStep calls `captureBefore()` just before a Process node
 * runs and `captureAfterAndEmit()` just after, when that node has a binding whose
 * validated package capability declares snapshot-eligible host-path access. Both are BEST-EFFORT and never throw —
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
import { hostPathCapabilityOf } from '@/utils/shared/mcpConstants';

const log = createLogger('backend/services/snapshot/snapshotHook');

export interface SnapshotContext {
  /** Confinement roots being watched for this Process-node visit. */
  roots: string[];
  /** root → start-snapshot SHA (or null when capture was disabled/failed). */
  start: Map<string, string | null>;
  /** Host-access package(s) whose confined binding contributed each root. */
  rootServers: Map<string, string[]>;
}

type ArmedBinding = { serverName: string; nodeId?: string };

/** Read MCP bindings from the compiled Process node (opaque handle probe). */
function armedBindings(node: ResolvedNode): ArmedBinding[] {
  const bindings: ArmedBinding[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpNodes = (node as any)?.handle?.node_params?.properties?.mcpNodes;
    if (!Array.isArray(mcpNodes)) return bindings;
    for (const m of mcpNodes) {
      const serverName = m?.properties?.boundServer;
      if (typeof serverName !== 'string' || serverName.length === 0) continue;
      const candidateNodeId = m?.id ?? m?.properties?.id;
      bindings.push({
        serverName,
        ...(typeof candidateNodeId === 'string' ? { nodeId: candidateNodeId } : {}),
      });
    }
  } catch (err) {
    log.debug('armedBindings probe failed', { err });
  }
  return bindings;
}

/** Resolve snapshot-capable bindings and their roots from persisted contracts. */
async function resolveArmedRoots(
  node: ResolvedNode,
): Promise<{ roots: string[]; rootServers: Map<string, string[]> }> {
  const bindings = armedBindings(node);
  const rootServers = new Map<string, string[]>();
  if (bindings.length === 0) return { roots: [], rootServers };
  try {
    const [{ loadEffectiveRoots }, { loadServerConfigs }] = await Promise.all([
      import('@/backend/services/mcp/internal/confinement'),
      import('@/backend/services/mcp/config'),
    ]);
    const loaded = await loadServerConfigs();
    if (!Array.isArray(loaded)) return { roots: [], rootServers };
    const configs = new Map(loaded.map((config) => [config.name, config]));

    for (const binding of bindings) {
      const config = configs.get(binding.serverName);
      const capability = hostPathCapabilityOf(config);
      if (!config || capability?.snapshots !== true) continue;
      const roots = await loadEffectiveRoots(
        binding.serverName,
        capability.environmentRootVariables,
        binding.nodeId,
      );
      for (const root of roots) {
        const contributors = rootServers.get(root) ?? [];
        if (!contributors.includes(binding.serverName)) contributors.push(binding.serverName);
        rootServers.set(root, contributors);
      }
    }
  } catch (err) {
    log.warn('resolveArmedRoots failed', { err });
  }
  return { roots: [...rootServers.keys()], rootServers };
}

function nodeRef(node: ResolvedNode): NodeRef {
  return { nodeId: node.id, nodeName: node.name, nodeType: node.type };
}

/**
 * Take the START snapshot for an armed Process node. Returns null when there is
 * nothing to snapshot (not a process node, ephemeral run, no snapshot-capable
 * host-path binding, or no git-repo root). Never throws.
 */
export async function captureBefore(
  node: ResolvedNode,
  sharedState: SharedState,
  emit?: EmitFn
): Promise<SnapshotContext | null> {
  try {
    if (node.type !== 'process') return null;
    if (sharedState.ephemeral) return null;
    const { roots, rootServers } = await resolveArmedRoots(node);
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
    return anyCaptured ? { roots, start, rootServers } : null;
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
                    server: ctx.rootServers.get(root)?.[0],
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
