/**
 * Editable flows shipped with FLUJO (issue #338).
 *
 * Vendored flows are ordinary saved flows after their first seed. Startup creates
 * a missing flow and performs the one known v1→v2 repair; that save archives the
 * old definition. Other existing/editable definitions are left untouched.
 */
import type { Flow } from '@/shared/types/flow';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { flowService } from './index';
import {
  DEFAULT_GENERATED_SUBFLOW_DEPTH,
  GENERATED_FLOW_AUTHORING_POLICY,
} from './generationDraft';

export const FLOW_GENERATOR_ID = 'system-flow-generator';
export const FLOW_GENERATOR_VERSION = 5;
export const FLOW_GENERATOR_ROLE = 'flow-generator';

const SAFE_AUTHORING_TOOLS = [
  'list_flow_building_blocks',
  'get_flow_authoring_guide',
  'draft_generated_flow',
  'find_mcp_server',
  'find_best_mcp_server',
] as const;
const INSTALL_AUTHORING_TOOLS = [
  'install_mcp_server',
  'install_best_mcp_server',
] as const;
const ALL_AUTHORING_TOOLS = [
  ...SAFE_AUTHORING_TOOLS,
  ...INSTALL_AUTHORING_TOOLS,
] as const;

const GENERATOR_PROMPT = `You are the experimental, completely Flow-based FLUJO Flow Generator.

Every user turn is an instruction to CREATE or REVISE an unsaved Flow draft. You must produce a draft on every turn. Never stop at advice, a design discussion, a promise to build later, or a clarifying question. When details are missing, make sensible reversible assumptions and continue.

This Flow is the editable expression of the production generator:
1. Flow Architect performs the production generator's model-driven authoring and capability-discovery stage.
2. Generation Compiler invokes the SAME deterministic hardening pipeline used by the production generator.

Prefer a small, clear root Flow, but create inline subflowSpec / parallelSubflowSpecs when a task has self-contained phases. New nested subflows are enabled by default, bounded to ${DEFAULT_GENERATED_SUBFLOW_DEPTH} nesting levels and six generated flows total. Never call create_flow: the result must remain unsaved until the user opens it in the builder.

${GENERATED_FLOW_AUTHORING_POLICY}`;

const ARCHITECT_PROMPT = `You are the Flow Architect stage.

On EVERY visit:
1. Call list_flow_building_blocks before authoring so every model, MCP server/tool, and existing-flow reference is real.
2. Call get_flow_authoring_guide with profile "advanced".
3. Read the newest user instruction. If the transcript already contains a prior draft_generated_flow call/result, treat this as a revision: start from its returned hardened "spec", preserve everything not requested to change, and emit a complete replacement specification.
4. If a required external capability is missing, search the MCP marketplace. Install only when the run's MCP installation policy explicitly permits it and installation tools are actually available.
5. Return ONLY one complete advanced FlowSpec JSON object as your final response—no prose or Markdown fences.

Use inline subflowSpec / parallelSubflowSpecs for newly-created subflows. Do not emit generateSubflow because the deterministic compiler cannot expand it. Use \${var:NAME} with captureVariable for values passed between steps in this run. Do not generate captureKv or \${kv:...}: persistent cross-run state requires an explicit author decision about scope and retention. Do not merely explain what you would build.`;

const COMPILER_PROMPT = `You are the Generation Compiler and repair stage.

Find the newest complete advanced FlowSpec JSON produced by the Flow Architect. Call draft_generated_flow with that complete specification. This tool is not a generic compiler: it executes the exact deterministic post-model pipeline shared with FLUJO's production generator—scratchpad guard, forgiving structural repair, bounded nested compilation, generated input/output defaults, and whole-bundle validation.

If the first result contains validation errors, repair the COMPLETE returned spec using its issues and call draft_generated_flow one more time, matching the production generator's default single repair round. Never call create_flow or substitute generic draft_flow. Never finish with only prose, a promise, or JSON that was not submitted to draft_generated_flow.

After a usable draft_generated_flow result exists, respond with only a short factual summary. The tool result—not your prose—is the authoritative unsaved draft returned to the UI.`;

/** Build the bundled definition without reading or writing storage. */
export function buildVendoredFlowGenerator(): Flow {
  const compiled = compileFlowSpec({
    name: 'Flow_Generator',
    description:
      'Experimental editable multi-stage Flow Generator: architecture, capability discovery, validation, repair, and unsaved drafting.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: GENERATOR_PROMPT },
      {
        key: 'architect',
        type: 'process',
        label: 'Flow Architect',
        description: 'Inventories real building blocks and authors a complete advanced FlowSpec.',
        prompt: ARCHITECT_PROMPT,
        maxTurns: 12,
        inputMode: 'full-history',
        outputMode: 'latest-message',
        servers: [{
          name: 'flujo',
          tools: [
            'list_flow_building_blocks',
            'get_flow_authoring_guide',
            'find_mcp_server',
            'find_best_mcp_server',
            ...INSTALL_AUTHORING_TOOLS,
          ],
        }],
      },
      {
        key: 'compiler',
        type: 'process',
        label: 'Generation Compiler',
        description: 'Runs the production generator hardening pipeline and one bounded repair round.',
        prompt: COMPILER_PROMPT,
        maxTurns: 16,
        inputMode: 'full-history',
        outputMode: 'latest-message',
        servers: [{
          name: 'flujo',
          tools: ['draft_generated_flow'],
        }],
      },
      { key: 'finish', type: 'finish', label: 'Finish' },
    ],
    edges: [
      { from: 'start', to: 'architect' },
      { from: 'architect', to: 'compiler' },
      { from: 'compiler', to: 'finish' },
    ],
  }, {
    servers: [{ name: 'flujo' }],
    serverTools: {
      flujo: [...ALL_AUTHORING_TOOLS],
    },
  });
  if (!compiled.flow) {
    throw new Error('Bundled Flow Generator could not be compiled');
  }

  compiled.flow.id = FLOW_GENERATOR_ID;
  compiled.flow.name = 'Experimental Flow Generator';
  compiled.flow.folder = 'System';
  // The saved/editable system Flow can discover marketplace options but cannot
  // install. An opted-in session snapshot adds the install tools below.
  const installNames = new Set<string>(INSTALL_AUTHORING_TOOLS);
  for (const node of compiled.flow.nodes.filter((candidate) => candidate.type === 'mcp')) {
    const enabled = node.data?.properties?.enabledTools;
    if (Array.isArray(enabled)) {
      node.data.properties = {
        ...(node.data.properties ?? {}),
        enabledTools: enabled.filter((tool) => !installNames.has(String(tool))),
      };
    }
  }
  const stages = compiled.flow.nodes.filter((node) => node.type === 'process');
  if (stages.length !== 2) {
    throw new Error('Bundled Flow Generator must contain architect and compiler stages');
  }
  stages.forEach((stage, index) => {
    stage.data.properties = {
      ...(stage.data.properties ?? {}),
      systemRole: FLOW_GENERATOR_ROLE,
      systemStage: index === 0 ? 'architect' : 'compiler',
      systemFlowVersion: FLOW_GENERATOR_VERSION,
    };
  });
  return compiled.flow;
}

/**
 * Seed once when missing. Versions 1–4 predate the current authoring guidance.
 * Upgrade those exact bundled versions once; saveFlow archives the prior definition
 * so edits remain recoverable.
 */
export async function ensureVendoredFlowGenerator(): Promise<Flow> {
  const existing = await flowService.getFlow(FLOW_GENERATOR_ID);
  const existingVersion = existing?.nodes
    .filter((node) => node.type === 'process')
    .map((node) => Number(node.data?.properties?.systemFlowVersion ?? 0))
    .find((version) => version > 0);
  if (existing && existingVersion !== 1 && existingVersion !== 2 && existingVersion !== 3 && existingVersion !== 4) return existing;
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
  options?: { allowInstall?: boolean },
): Promise<Flow> {
  const source = await ensureVendoredFlowGenerator();
  const snapshot = JSON.parse(JSON.stringify(source)) as Flow;
  snapshot.id = `quickchat-flow-generator-${conversationId}`;
  snapshot.name = 'Flow Generator Session';
  delete snapshot.createdAt;
  delete snapshot.updatedAt;

  const stages = snapshot.nodes.filter(
    (node) =>
      node.type === 'process' &&
      node.data?.properties?.systemRole === FLOW_GENERATOR_ROLE,
  );
  if (stages.length < 2) {
    throw new Error(
      'The editable Flow Generator is missing its architect/compiler stages. Restore the default generator or add the flow-generator roles back.',
    );
  }
  for (const stage of stages) {
    stage.data.properties = {
      ...(stage.data.properties ?? {}),
      boundModel: modelId,
    };
  }

  const allowInstall = options?.allowInstall === true;
  const installNames = new Set<string>(INSTALL_AUTHORING_TOOLS);
  if (allowInstall) {
    for (const node of snapshot.nodes.filter((candidate) => candidate.type === 'mcp')) {
      const enabled = Array.isArray(node.data?.properties?.enabledTools)
        ? node.data.properties.enabledTools.map(String)
        : [];
      node.data.properties = {
        ...(node.data.properties ?? {}),
        enabledTools: [...new Set([...enabled, ...INSTALL_AUTHORING_TOOLS])],
      };
    }
  } else {
    for (const node of snapshot.nodes.filter((candidate) => candidate.type === 'mcp')) {
      const enabled = node.data?.properties?.enabledTools;
      if (Array.isArray(enabled)) {
        node.data.properties = {
          ...(node.data.properties ?? {}),
          enabledTools: enabled.filter((tool) => !installNames.has(String(tool))),
        };
      }
    }
  }

  const start = snapshot.nodes.find((node) => node.type === 'start');
  if (start) {
    const policy = allowInstall
      ? 'MCP INSTALLATION POLICY FOR THIS RUN: explicitly opted in. Marketplace search and install tools may be used; consent/audit enforcement still applies.'
      : 'MCP INSTALLATION POLICY FOR THIS RUN: NOT opted in. Marketplace search is allowed for recommendations, but installation tools have been removed. Do not install or reference an unconfigured server in the draft.';
    start.data.properties = {
      ...(start.data.properties ?? {}),
      promptTemplate: `${String(start.data.properties?.promptTemplate ?? '')}\n\n${policy}`,
    };
  }
  return snapshot;
}
