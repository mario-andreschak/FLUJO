/**
 * Editable flows shipped with FLUJO (issue #338).
 *
 * Vendored flows are ordinary saved flows after their first seed. Startup only
 * creates a missing flow and never overwrites user edits. Restoring the bundled
 * definition is an explicit action so version history remains meaningful.
 */
import type { Flow } from '@/shared/types/flow';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { flowService } from './index';

export const FLOW_GENERATOR_ID = 'system-flow-generator';
export const FLOW_GENERATOR_VERSION = 1;
export const FLOW_GENERATOR_ROLE = 'flow-generator';

const GENERATOR_PROMPT = `You are FLUJO's guided Flow Generator.

Help the user design a workflow through a short conversation. Ask only for missing information that materially changes the design: the goal, required output, or external capability. Ask at most one concise question at a time.

Before drafting, call list_flow_building_blocks so every model, tool, and existing-flow reference is real. Use the default simple authoring profile. Do not ask the user about input modes, output modes, resources, variables, KV, fan-out, concurrency, prompt exclusions, or graph wiring; the compiler owns those defaults.

When the request is sufficiently clear, call draft_flow with a SimpleFlowSpec. Never call create_flow: the user must review the unsaved draft in the builder. After draft_flow returns, briefly summarize the proposed steps and invite the user to open the draft or request a revision. For a revision, call draft_flow again with a complete replacement SimpleFlowSpec.`;

/** Build the bundled definition without reading or writing storage. */
export function buildVendoredFlowGenerator(): Flow {
  const compiled = compileFlowSpec({
    name: 'Flow_Generator',
    description:
      'Editable guided flow used by the Generate Flow chat. FLUJO seeds it once and never overwrites your changes.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: GENERATOR_PROMPT },
      {
        key: 'designer',
        type: 'process',
        label: 'Flow Designer',
        description: 'Clarifies the request and proposes an unsaved guided draft.',
        maxTurns: 16,
        inputMode: 'full-history',
        outputMode: 'latest-message',
        servers: [{
          name: 'flujo',
          tools: [
            'list_flow_building_blocks',
            'get_flow_authoring_guide',
            'draft_flow',
          ],
        }],
      },
      { key: 'finish', type: 'finish', label: 'Finish' },
    ],
    edges: [
      { from: 'start', to: 'designer' },
      { from: 'designer', to: 'finish' },
    ],
  }, {
    servers: [{ name: 'flujo' }],
    serverTools: {
      flujo: [
        'list_flow_building_blocks',
        'get_flow_authoring_guide',
        'draft_flow',
      ],
    },
  });
  if (!compiled.flow) {
    throw new Error('Bundled Flow Generator could not be compiled');
  }

  compiled.flow.id = FLOW_GENERATOR_ID;
  compiled.flow.name = 'Flow Generator';
  compiled.flow.folder = 'System';
  compiled.flow.permissionRules = [
    { action: 'list_flow_building_blocks', resource: '*', effect: 'allow' },
    { action: 'get_flow_authoring_guide', resource: '*', effect: 'allow' },
    { action: 'draft_flow', resource: '*', effect: 'allow' },
  ];
  const designer = compiled.flow.nodes.find((node) => node.type === 'process');
  if (!designer) throw new Error('Bundled Flow Generator has no designer process');
  designer.data.properties = {
    ...(designer.data.properties ?? {}),
    systemRole: FLOW_GENERATOR_ROLE,
    systemFlowVersion: FLOW_GENERATOR_VERSION,
  };
  return compiled.flow;
}

/** Seed once when missing. Existing/editable definitions are returned untouched. */
export async function ensureVendoredFlowGenerator(): Promise<Flow> {
  const existing = await flowService.getFlow(FLOW_GENERATOR_ID);
  if (existing) return existing;
  const bundled = buildVendoredFlowGenerator();
  const saved = await flowService.saveFlow(bundled);
  if (!saved.success) {
    throw new Error(saved.error ?? 'Failed to seed the Flow Generator');
  }
  return bundled;
}

/** Explicitly restore the current bundled definition, archiving user edits. */
export async function restoreVendoredFlowGenerator(): Promise<Flow> {
  const bundled = buildVendoredFlowGenerator();
  const saved = await flowService.saveFlow(bundled);
  if (!saved.success) {
    throw new Error(saved.error ?? 'Failed to restore the Flow Generator');
  }
  return bundled;
}

/**
 * Clone the latest editable definition for one conversation and bind the model
 * selected in the modal. The saved source flow itself remains model-agnostic.
 */
export async function buildFlowGeneratorSnapshot(
  conversationId: string,
  modelId: string,
): Promise<Flow> {
  const source = await ensureVendoredFlowGenerator();
  const snapshot = JSON.parse(JSON.stringify(source)) as Flow;
  snapshot.id = `quickchat-flow-generator-${conversationId}`;
  snapshot.name = 'Flow Generator Session';
  delete snapshot.createdAt;
  delete snapshot.updatedAt;

  const designer = snapshot.nodes.find(
    (node) =>
      node.type === 'process' &&
      node.data?.properties?.systemRole === FLOW_GENERATOR_ROLE,
  );
  if (!designer) {
    throw new Error(
      'The editable Flow Generator has no process marked as the flow-generator role. Restore the default generator or add that role back.',
    );
  }
  designer.data.properties = {
    ...(designer.data.properties ?? {}),
    boundModel: modelId,
  };
  return snapshot;
}
