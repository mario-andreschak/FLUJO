/**
 * Restart/reconnect resume for remote MCP tasks (issue #404, plan steps 6 & 8).
 *
 * Unlike detached subflow tasks (which FLUJO executes itself and therefore fails
 * on restart), a remote task keeps running inside another process. After a
 * restart FLUJO therefore resumes POLLING — but only when it can prove it is
 * talking to the same server:
 *
 *  - the server config must still exist (else `server-missing`);
 *  - its non-secret identity fingerprint must still match (else
 *    `identity-mismatch`) — this is what prevents ever polling the wrong server
 *    after a URL/command/auth change that reused the server name;
 *  - the record must be non-terminal and not expired.
 *
 * The originating run cannot accept a result after a restart, so a resumed task
 * is polled for OBSERVABILITY only: its terminal state is recorded (with the
 * `owner-unavailable` diagnostic) and the payload is deliberately left on the
 * server rather than fetched and stored.
 *
 * Kept in its own module (and importing the MCP service lazily) so the startup
 * path in backend/init.ts does not create an import cycle with the MCP service.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';
import { sleep } from '@/backend/utils/sleep';
import type { MCPServerConfig } from '@/shared/types/mcp/mcp';
import { clampPollIntervalMs, isTerminalMcpTaskStatus } from '@/shared/types/mcp/tasks';
import type { McpRemoteTaskRecord } from '@/shared/types/mcp/taskRecords';
import {
  acquirePollSlot,
  getMcpRemoteTaskSettings,
  listResumableRemoteTaskRecords,
  patchRemoteTaskRecord,
  serverIdentityFingerprint,
} from './remoteTaskStore';
import { fetchTaskStatus, mcpTasksClientEnabled } from './tasksProtocol';

const log = createLogger('backend/services/mcp/remoteTaskResume');

/** Hard cap on how long a resumed (undeliverable) task is polled. */
const MAX_RESUME_WALL_CLOCK_MS = 15 * 60 * 1_000;

export interface ResumeSummary {
  resumed: number;
  failedClosed: number;
  skipped: number;
}

export async function resumeRemoteMcpTasks(): Promise<ResumeSummary> {
  const summary: ResumeSummary = { resumed: 0, failedClosed: 0, skipped: 0 };
  if (!mcpTasksClientEnabled()) {
    log.debug('MCP Tasks client support disabled; skipping remote task resume');
    return summary;
  }

  const records = await listResumableRemoteTaskRecords();
  if (records.length === 0) return summary;

  // Imported lazily: the MCP service imports the tool layer, which imports this
  // feature's protocol adapter.
  const { mcpService } = await import('@/backend/services/mcp');
  let configs: MCPServerConfig[] = [];
  try {
    configs = (await mcpService.loadServerConfigs()) as MCPServerConfig[];
  } catch (error) {
    log.warn('Could not load MCP server configs; skipping remote task resume', error);
    return summary;
  }
  if (!Array.isArray(configs)) return summary;

  for (const record of records) {
    const config = configs.find(c => c.name === record.serverName);
    if (!config) {
      await patchRemoteTaskRecord(record.recordId, {
        status: 'failed',
        diagnostic: 'server-missing',
        errorMessage: 'MCP server configuration no longer exists; task cannot be resumed.',
      });
      summary.failedClosed++;
      continue;
    }

    if (serverIdentityFingerprint(config) !== record.serverIdentity) {
      await patchRemoteTaskRecord(record.recordId, {
        status: 'failed',
        diagnostic: 'identity-mismatch',
        errorMessage:
          'MCP server connection identity changed; task was not resumed against a different server.',
      });
      summary.failedClosed++;
      continue;
    }

    const client = mcpService.getClient(record.serverName);
    if (!client) {
      // Not an error: the server may connect later. Leave the record
      // non-terminal with a diagnostic so the next sweep can retry.
      await patchRemoteTaskRecord(record.recordId, { diagnostic: 'server-disconnected' });
      summary.skipped++;
      continue;
    }

    summary.resumed++;
    void pollResumedRecord(record, client).catch(error =>
      log.warn(`Resumed poll for task ${record.remoteTaskId} failed:`, error),
    );
  }

  log.info(
    `Remote MCP task resume: resumed=${summary.resumed}, failed-closed=${summary.failedClosed}, skipped=${summary.skipped}`,
  );
  return summary;
}

async function pollResumedRecord(
  record: McpRemoteTaskRecord,
  client: Client,
): Promise<void> {
  const settings = await getMcpRemoteTaskSettings();
  const slot = await acquirePollSlot(record.serverName);
  if (!slot) {
    await patchRemoteTaskRecord(record.recordId, { diagnostic: 'poll-limit' });
    return;
  }

  const startedAt = Date.now();
  const pollMs = clampPollIntervalMs(record.pollIntervalMs, {
    minMs: settings.minPollIntervalMs,
    maxMs: settings.maxPollIntervalMs,
    defaultMs: settings.defaultPollIntervalMs,
  });
  let transientFailures = 0;

  try {
    await patchRemoteTaskRecord(record.recordId, {
      diagnostic: 'process-restart-resumed',
    });

    while (true) {
      if (record.expiresAt !== undefined && Date.now() >= record.expiresAt) {
        await patchRemoteTaskRecord(record.recordId, {
          status: 'failed',
          diagnostic: 'expired',
          errorMessage: 'Remote MCP task expired while being resumed.',
        });
        return;
      }
      if (Date.now() - startedAt >= MAX_RESUME_WALL_CLOCK_MS) {
        await patchRemoteTaskRecord(record.recordId, { diagnostic: 'owner-unavailable' });
        return;
      }

      await sleep(pollMs);

      let status: Awaited<ReturnType<typeof fetchTaskStatus>>;
      try {
        status = await fetchTaskStatus(client, record.remoteTaskId, { timeout: 30_000 });
        transientFailures = 0;
      } catch (error) {
        transientFailures++;
        if (transientFailures >= settings.maxTransientPollFailures) {
          await patchRemoteTaskRecord(record.recordId, {
            status: 'failed',
            diagnostic: 'transport-error',
            errorMessage: `Resumed tasks/get failed repeatedly: ${String(error)}`,
          });
          return;
        }
        continue;
      }

      if (!status.ok) {
        await patchRemoteTaskRecord(record.recordId, {
          status: 'failed',
          diagnostic: 'protocol-invalid',
          errorMessage: `Invalid tasks/get result while resuming: ${status.reason}`,
        });
        return;
      }

      const updated = await patchRemoteTaskRecord(record.recordId, {
        status: status.task.status,
        statusMessage: status.task.statusMessage,
        lastPolledAt: Date.now(),
        nextPollAt: Date.now() + pollMs,
        // The originating run is gone: the terminal payload is intentionally
        // NOT fetched or persisted.
        ...(isTerminalMcpTaskStatus(status.task.status)
          ? { diagnostic: 'owner-unavailable' as const, resultRetrieved: false }
          : {}),
      });
      if (updated) record = updated;
      if (isTerminalMcpTaskStatus(status.task.status)) {
        log.info(
          `Resumed remote MCP task ${record.remoteTaskId} reached terminal state ${status.task.status}`,
        );
        return;
      }
    }
  } finally {
    slot.release();
  }
}
