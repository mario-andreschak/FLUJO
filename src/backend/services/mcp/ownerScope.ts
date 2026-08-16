/**
 * Stable run ownership for MCP-side resources (issue #413).
 *
 * The Bash server keys every background/PTY session by an owner scope supplied
 * through `_meta.flujo.ownerScope`. Ownership only works if EVERY path to a tool
 * call derives the SAME key for the same run — the normal ModelHandler path, the
 * Codex adapter and the Claude adapter previously disagreed (two passed nothing
 * at all), so a run's sessions could land under three different owners and none
 * of them could be released when the run ended.
 *
 * The key is `run:<runId>` where a logical run id exists, because that is the
 * unit whose end must release resources. A conversation can span many runs, so
 * `conversation:<conversationId>` is only the fallback for callers that have no
 * distinct run id (interactive chat control routes). `caller:<nodeId>` remains
 * the Bash server's own last-resort namespace and is intentionally NOT produced
 * here — a node id is not a lifetime.
 */
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/ownerScope');

export interface OwnerScopeSource {
  /** Logical run id (`SharedState.logicalRunId`) — preferred. */
  runId?: string;
  /** Conversation id — fallback only. */
  conversationId?: string;
}

/**
 * Derive the canonical owner scope for a run, or undefined when neither id is
 * known (in which case the Bash server falls back to its caller namespace).
 */
export function ownerScopeForRun(source: OwnerScopeSource): string | undefined {
  const runId = source.runId?.trim();
  if (runId) return `run:${runId}`;
  const conversationId = source.conversationId?.trim();
  if (conversationId) return `conversation:${conversationId}`;
  return undefined;
}

/**
 * Release every non-detached Bash session owned by a finished run.
 *
 * Called from the run's terminal path. Best-effort by design: the Bash server may
 * legitimately be cold (lazy pool) or already gone, and a failure here must never
 * turn a completed run into a failed one. It deliberately does NOT connect a cold
 * server — with no warm Bash server there are no sessions to release.
 */
export async function releaseRunOwnedBashSessions(
  ownerScope: string | undefined,
  serverName = 'bash',
): Promise<void> {
  if (!ownerScope) return;
  try {
    const { mcpService } = await import('./index');
    if (!mcpService.getClient(serverName)) {
      // Cold Bash server: nothing of ours can be alive inside it.
      return;
    }
    const result = await mcpService.callTool(
      serverName,
      'release_owner',
      {},
      30,
      undefined,
      undefined,
      undefined,
      'host',
      ownerScope,
    );
    if (!result.success) {
      log.debug(`releaseRunOwnedBashSessions: release_owner reported ${result.error}`);
    }
  } catch (error) {
    log.debug(
      `releaseRunOwnedBashSessions: release for ${ownerScope} failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
