/**
 * The general-purpose Agent shipped with a fresh FLUJO workspace.
 *
 * Keep this definition deliberately neutral: the user chooses the model and
 * supplies the conversation prompt. The four shipped MCP servers are attached
 * to the Process node so their tools can be selected as those servers become
 * available.
 */
import type { Flow } from '@/shared/types/flow';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { flowService } from './index';

export const DEFAULT_FLUJO_AGENT_ID = 'default-agent-flujo';
export const DEFAULT_FLUJO_AGENT_SERVERS = [
  'bash',
  'browser',
  'filesystem',
  'flujo',
] as const;

/** Build the bundled definition without reading or writing storage. */
export function buildDefaultFlujoAgent(): Flow {
  const compiled = compileFlowSpec(
    {
      name: 'FLUJO',
      nodes: [
        { key: 'start', type: 'start', label: 'Start Node' },
        {
          key: 'process',
          type: 'process',
          label: 'Process Node',
          inputMode: 'full-history',
          servers: DEFAULT_FLUJO_AGENT_SERVERS.map((name) => ({ name })),
        },
        { key: 'finish', type: 'finish' },
      ],
      edges: [
        { from: 'start', to: 'process' },
        { from: 'process', to: 'finish' },
      ],
    },
    {
      servers: DEFAULT_FLUJO_AGENT_SERVERS.map((name) => ({ name })),
    },
  );

  if (!compiled.flow) {
    throw new Error('Bundled FLUJO Agent could not be compiled');
  }

  compiled.flow.id = DEFAULT_FLUJO_AGENT_ID;
  compiled.flow.name = 'FLUJO';
  compiled.flow.favorite = true;
  return compiled.flow;
}

/** Seed the shipped Agent when missing, without overwriting user edits. */
export async function ensureDefaultFlujoAgent(): Promise<Flow> {
  const existing = await flowService.getFlow(DEFAULT_FLUJO_AGENT_ID);
  if (existing) return existing;

  const bundled = buildDefaultFlujoAgent();
  const saved = await flowService.saveFlow(bundled);
  if (!saved.success) {
    throw new Error(saved.error ?? 'Failed to seed the default FLUJO Agent');
  }
  return bundled;
}
