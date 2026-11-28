// Deleting a workspace: stop its Persona goals and tool servers, then remove its files.
import { removeWorkspace } from '@/utils/workspace';
import { stopAndDrainPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntime';
import { mcpService } from '@/backend/services/mcp';

/** Permanently delete a non-default workspace and all of its owned data. */
export async function deleteWorkspace(workspace: string): Promise<void> {
  await removeWorkspace(workspace, stopWorkspaceRuntime);
}

/** Runs inside the workspace being deleted; refuses while a tool server may still hold its files. */
async function stopWorkspaceRuntime(): Promise<void> {
  await stopAndDrainPersonaGoalRuntime();
  const disconnected = await mcpService.disconnectAll('workspace deletion');
  const unconfirmed = new Set(disconnected.failed);
  for (const receipt of disconnected.shutdownReceipts) {
    if (receipt.exitOutcome === 'unknown' || receipt.isolation?.cleanupOutcome === 'unknown') unconfirmed.add(receipt.serverName);
  }
  if (unconfirmed.size > 0) {
    throw new Error(`Cannot delete workspace while ${unconfirmed.size} MCP server(s) remain open.`);
  }
}
