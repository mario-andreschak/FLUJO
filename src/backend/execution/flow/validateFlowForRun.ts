import { createLogger } from '@/utils/logger';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { validateFlow, FlowValidationResult } from '@/utils/shared/flowValidation';
import { Flow } from '@/shared/types/flow';

const log = createLogger('backend/execution/flow/validateFlowForRun');

/**
 * Pre-flight consistency check for an in-memory flow definition (a Quick-Chat
 * snapshot, issue #61, which never enters the flows store). Same model/server
 * context and validator as {@link validateFlowForRun}, just against the object
 * the caller already holds instead of a store lookup by id.
 */
export async function validateFlowObjectForRun(flow: Flow): Promise<FlowValidationResult> {
  let models: Array<{ id: string; name?: string; displayName?: string }> | undefined;
  try {
    models = await modelService.loadModels();
  } catch (error) {
    log.warn('validateFlowObjectForRun: could not load models; skipping model checks', error);
  }

  let servers: Array<{ name: string; status?: string }> | undefined;
  let configs: any[] | undefined;
  try {
    const rawConfigs = await mcpService.loadServerConfigs();
    if (Array.isArray(rawConfigs)) {
      configs = rawConfigs;
      servers = rawConfigs.map((s: { name: string; disabled?: boolean }) => ({
        name: s.name,
        status: s.disabled ? 'disabled' : undefined,
      }));
    }
  } catch (error) {
    log.warn('validateFlowObjectForRun: could not load servers; skipping server checks', error);
  }

  // Build serverTools: query each MCP server referenced by an MCP node in this
  // flow so the validator can flag tool-unavailable and mcp-server-no-tools.
  // Mirrors the FlowValidationButton frontend pattern (see FlowValidationButton.tsx).
  let serverTools: Record<string, string[]> | undefined;
  try {
    const disabledByName = new Map(
      (Array.isArray(configs) ? configs : []).map(
        (s: { name: string; disabled?: boolean }) => [s.name, !!s.disabled]
      )
    );
    const flowServers = new Set<string>();
    for (const node of ((flow as any).nodes ?? []) as any[]) {
      const nodeType = node?.data?.type ?? node?.type;
      const bound = node?.data?.properties?.boundServer;
      if (nodeType === 'mcp' && typeof bound === 'string' && bound) {
        flowServers.add(bound);
      }
    }

    const entries = await Promise.all(
      [...flowServers].map(async (name) => {
        if (disabledByName.get(name)) return null; // disabled → leave as unknown
        const res = await mcpService.listServerTools(name);
        if (res.error || !Array.isArray(res.tools)) return null; // offline → unknown
        const toolNames = (res.tools as Array<{ name?: string }>)
          .map((t) => t?.name)
          .filter((x): x is string => typeof x === 'string');
        return [name, toolNames] as [string, string[]];
      })
    );

    serverTools = {};
    for (const entry of entries) {
      if (entry) serverTools[entry[0]] = entry[1];
    }
  } catch (error) {
    log.warn('validateFlowObjectForRun: could not gather serverTools; skipping tool checks', error);
    serverTools = undefined;
  }

  return validateFlow(flow as any, { models, servers, serverTools });
}

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

  return validateFlowObjectForRun(flow as Flow);
}
