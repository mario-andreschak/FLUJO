import { createLogger } from '@/utils/logger';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { validateFlow, FlowValidationResult } from '@/utils/shared/flowValidation';

const log = createLogger('backend/execution/flow/validateFlowForRun');

/**
 * Pre-flight consistency check for a flow about to run.
 *
 * Loads the flow plus the current models and servers and runs the shared validator, so a
 * flow that references a deleted model, has no Start node, dangling tool references, etc. is
 * caught BEFORE any node executes. Errors block the run; warnings don't.
 *
 * A bound MCP server that's missing from the list is only a warning (not blocking): absence
 * is ambiguous — the server may be renamed/removed, or just offline (e.g. VPN down) — so we
 * don't block a run over it; the run simply lacks those tools if the server never comes up.
 * Server live status isn't consulted here (names + the disabled flag are enough for the
 * advisory checks). Model/server context is only passed to the validator when it loads
 * cleanly, so a transient load failure skips that family of checks rather than falsely
 * flagging every binding.
 */
export async function validateFlowForRun(flowId: string): Promise<FlowValidationResult> {
  const flow = await flowService.getFlow(flowId);
  if (!flow) {
    // If the flow can't be loaded, that's the engine's error to raise (it loads the flow
    // too). The pre-flight check is about consistency, not existence — skip rather than
    // block, so a transient load issue never wrongly stops a run.
    log.warn(`validateFlowForRun: flow ${flowId} could not be loaded; skipping pre-run checks`);
    return { issues: [], errorCount: 0, warningCount: 0, isRunnable: true };
  }

  let models: Array<{ id: string; name?: string; displayName?: string }> | undefined;
  try {
    models = await modelService.loadModels();
  } catch (error) {
    log.warn('validateFlowForRun: could not load models; skipping model checks', error);
  }

  let servers: Array<{ name: string; status?: string }> | undefined;
  try {
    const configs = await mcpService.loadServerConfigs();
    if (Array.isArray(configs)) {
      servers = configs.map((s) => ({ name: s.name, status: s.disabled ? 'disabled' : undefined }));
    }
  } catch (error) {
    log.warn('validateFlowForRun: could not load servers; skipping server checks', error);
  }

  return validateFlow(flow as any, { models, servers });
}
