/**
 * Flow-authoring tools for FLUJO's control-plane MCP package (#14 follow-up:
 * FlowSpec as the public authoring contract).
 *
 * Alongside flows-as-tools (flowTools.ts), the `/mcp-flows` server exposes three
 * authoring tools so any external MCP client can CREATE flows without ever writing
 * raw ReactFlow JSON — the calling agent authors the semantic FlowSpec and FLUJO's
 * deterministic compiler does the rest:
 *
 *   - list_flow_building_blocks: what a spec may reference (models, servers+tools,
 *     existing flows) — call this FIRST.
 *   - validate_flow_spec: compile + validate without saving; returns the issues an
 *     agent iterates on.
 *   - create_flow: compile + validate + save. Saving is gated on zero validation
 *     errors, so the loop is: blocks → spec → validate → fix → create.
 *   - suggest/apply tools + plausibility: consent-gated assistance for one Process
 *     step or a complete root/subflow draft bundle; none of these tools save.
 *   - search_mcp_marketplace / install_mcp_server: capability acquisition for the
 *     brain / self-improvement track — an external agent can find and install NEW
 *     MCP servers (downloading + running third-party packages on this host) and
 *     wire them into the flows it authors. Localhost-only posture, same as the
 *     endpoint itself; the install tool's description carries the warning.
 *
 * Transport-agnostic like flowTools.ts; the route merges both tool sets (authoring
 * names are reserved — a flow whose slug collides is shadowed with a warning).
 */
import { createLogger } from '@/utils/logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';
import type { FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { SIMPLE_FLOW_SPEC_SCHEMA } from '@/utils/shared/simpleFlowSpec';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { gatherGenerationContext } from '@/backend/services/flow/generationContext';
import { compileGeneratedDraft } from '@/backend/services/flow/generationDraft';
import {
  applyToolsToFlowStep,
  checkFlowPlausibility,
  suggestToolsForFlowStep,
} from '@/backend/services/flow/assistedAuthoring';
import type { Flow } from '@/shared/types/flow';
import type { StepToolSuggestion } from '@/shared/types/flow/assistance';
import { searchRegistry, installRegistryServer, installBestForCapability } from '@/backend/services/mcp/registryInstall';
import { loadAutoInstallSettings, appendInstallAudit } from '@/backend/services/mcp/autoInstall';
import { decideInstallConsent, planToAuditEntry } from '@/utils/mcp/autoInstallConsent';
import { isVerifiedStatus } from '@/utils/mcp/registry';
import {
  assertAllowedArguments,
  listInputSchema,
  optionalBoolean,
  optionalString,
  optionalStringArray,
} from './listQuery';

const log = createLogger('backend/services/mcp/flowAuthoringTools');

export const AUTHORING_TOOL_NAMES = [
  'list_flow_building_blocks',
  'get_flow_authoring_guide',
  'validate_flow_spec',
  'draft_flow',
  'draft_generated_flow',
  'create_flow',
  'suggest_tools_for_flow_step',
  'apply_tools_to_flow_step',
  'check_flow_plausibility',
  'search_mcp_marketplace',
  'install_mcp_server',
  'install_best_mcp_server',
] as const;

export function isAuthoringTool(name: string): boolean {
  return (AUTHORING_TOOL_NAMES as readonly string[]).includes(name);
}

/** JSON Schema for guided authoring, with the legacy advanced shape retained. */
function specInputSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      spec: {
        oneOf: [
          SIMPLE_FLOW_SPEC_SCHEMA,
          {
            type: 'object',
            description:
              'Legacy advanced FlowSpec with nodes and edges. Pass profile="advanced"; fetch its contract with get_flow_authoring_guide.',
          },
        ],
        description: 'A guided SimpleFlowSpec by default, or a legacy advanced FlowSpec.',
      },
      profile: {
        type: 'string',
        enum: ['simple', 'advanced'],
        description:
          'Authoring profile. Defaults to simple; legacy specs containing nodes+edges are auto-detected as advanced.',
      },
      keepPills: {
        type: 'boolean',
        description:
          'When true, binding pills (${tool:server__name}) that resolve against the node\'s wired servers are preserved in the compiled output instead of being stripped. Pills that cannot be resolved are still stripped with a warning. Default: false (strip all pills — generator-safe behaviour).',
      },
    },
    required: ['spec'],
  };
}

export function authoringToolDefinitions(): Tool[] {
  return [
    {
      name: 'list_flow_building_blocks',
      description:
        'List models, MCP server/tool references, and existing flows available to a new flow.',
      inputSchema: listInputSchema({
        query: { type: 'string', maxLength: 256, description: 'Case-insensitive search within the included categories.' },
        include: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: ['models', 'servers', 'flows'] },
          description: 'Categories to include (default all).',
        },
        connected: { type: 'boolean', description: 'When set, filter the server category by connection state.' },
      }, { common: false }),
    },
    {
      name: 'get_flow_authoring_guide',
      description:
        'Fetch the flow-authoring contract only when needed. The simple guide is compact; the advanced guide contains the complete FlowSpec reference.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            enum: ['simple', 'advanced'],
            description: 'Guide to return. Defaults to simple.',
          },
        },
      },
    },
    {
      name: 'validate_flow_spec',
      description:
        'Compile and validate a guided flow without saving. Returns a compact summary and issues. Use draft_flow when the caller needs the complete unsaved draft.',
      inputSchema: specInputSchema(),
    },
    {
      name: 'draft_flow',
      description:
        'Compile and validate a flow WITHOUT saving and return the complete draft bundle for review or opening in the Flow Builder.',
      inputSchema: specInputSchema(),
    },
    {
      name: 'draft_generated_flow',
      description:
        'Run the production Flow Generator post-processing pipeline on a complete advanced FlowSpec: scratchpad safety guard, structural auto-repair, bounded nested compilation, generated-flow defaults, and whole-bundle validation. Returns the complete UNSAVED draft and hardened spec.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spec: {
            type: 'object',
            description: 'A complete advanced FlowSpec authored using get_flow_authoring_guide(profile="advanced").',
          },
        },
        required: ['spec'],
      },
    },
    {
      name: 'create_flow',
      description:
        'Compile, validate, and save a guided flow. Saving occurs only when validation has no errors. Use list_flow_building_blocks for valid references.',
      inputSchema: specInputSchema(),
    },
    {
      name: 'suggest_tools_for_flow_step',
      description:
        'Use a selected AI model to suggest useful tools for ONE Process step from MCP servers that are already connected. Read-only: returns exact server/tool selections plus a proposed prompt containing canonical tool pills; it never changes or saves the flow.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flow: { type: 'object', description: 'Complete current Flow draft (ReactFlow shape).' },
          nodeId: { type: 'string', description: 'Exact id of the Process node to assist.' },
          modelId: { type: 'string', description: 'Configured model id used for the suggestion.' },
          goal: { type: 'string', description: 'Optional workflow goal; defaults to the flow description.' },
        },
        required: ['flow', 'nodeId', 'modelId'],
      },
    },
    {
      name: 'apply_tools_to_flow_step',
      description:
        'Apply an EXPLICITLY APPROVED list of connected MCP tools to one Process step in an UNSAVED Flow draft. Revalidates every tool against the live server, creates/reuses MCP attachments, enables only the approved tools, and rewrites the prompt with canonical tool pills. Idempotent and does not save.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flow: { type: 'object', description: 'Complete current Flow draft.' },
          nodeId: { type: 'string', description: 'Exact id of the Process node.' },
          selections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string' },
                tool: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['server', 'tool', 'reason'],
            },
          },
          proposedPrompt: { type: 'string', description: 'Optional complete prompt from the suggestion review.' },
        },
        required: ['flow', 'nodeId', 'selections'],
      },
    },
    {
      name: 'check_flow_plausibility',
      description:
        'Analyze an entire Flow and its recursively referenced subflows plus invocation context (chat, parent subflow/sub-agent, planned execution, Trigger Wave), every prompt, graph shape, and input/output mode. Returns issues, typed deterministic repair patches, and unsaved repaired previews. Read-only; the caller must obtain consent before using repairedFlow or repairedFlows.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flow: { type: 'object', description: 'Complete current Flow draft.' },
          relatedFlows: { type: 'array', items: { type: 'object' }, description: 'Unsaved related parent/child flow drafts.' },
          modelId: { type: 'string', description: 'Optional model for semantic prompt review.' },
          intendedContext: { type: 'string', enum: ['chat', 'headless'], description: 'Intended use for a new unsaved flow.' },
        },
        required: ['flow'],
      },
    },
    {
      name: 'search_mcp_marketplace',
      description:
        'Search the public MCP server registry for new capabilities (voice, browsing, files, email, vision, …). The registry matches the query against server NAMES only (substring) — use short single terms and try several. Returns name, description, whether FLUJO can install it, and which env vars/keys it would require.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short search term matched against server names.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'install_mcp_server',
      description:
        'Install an MCP server from the public registry (by the exact name returned by search_mcp_marketplace) and connect it — this DOWNLOADS AND RUNS a third-party package on the FLUJO host. Installs are gated by consent (SEP-1024): unless this trusted authoring tool is allowed via the mcpAutoInstall settings (trustBrainStem / requireConsent / namespaceAllowlist), the tool returns the exact resolved command + arguments with consentRequired=true INSTEAD of installing, and the caller must obtain explicit approval. Every attempt is written to an audit log (command, args, env NAMES, verification status — never secret values) before any spawn. Returns the FLUJO server name (reference it in FlowSpec "servers") and the tools it provides, or needsEnv when required keys are missing (supply values via the optional "env" argument), or the resolved plan when consent is required. First install can take minutes (package download).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact registry name from search results, e.g. "ai.keenable/web-search".' },
          env: {
            type: 'object',
            description: 'Optional env var values for the server (e.g. required API keys).',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'install_best_mcp_server',
      description:
        'Install the BEST WORKING MCP server for a capability, unattended — the recommended way to acquire a capability when you don\'t already have a specific server name. Searches the registry, RANKS candidates by blended quality (GitHub stars + recent activity, npm weekly downloads, registry status), then installs best→worst until one actually boots and exposes tools (the "works-gate"): candidates that need unavailable keys, can\'t be installed, or start with zero tools are skipped automatically. Same consent/audit rules and third-party-code warning as install_mcp_server. Returns the installed server name + its tools and the list of candidates tried, or needsEnv/consentRequired. Prefer this over search+install for headless self-improvement; use install_mcp_server only when you must pin an exact server.',
      inputSchema: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            description: 'Short capability term matched against server names, e.g. "youtube", "email", "browser".',
          },
          env: {
            type: 'object',
            description: 'Optional env var values shared across attempted servers (e.g. an API key).',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['capability'],
      },
    },
  ];
}

/** Tolerate the spec arriving as an object or a JSON string. */
function extractSpec(args: Record<string, unknown>): unknown {
  const raw = args?.spec;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw ?? null;
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function authoringCallTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const isFlow = (value: unknown): value is Flow => !!value && typeof value === 'object'
      && Array.isArray((value as Flow).nodes) && Array.isArray((value as Flow).edges);

    if (toolName === 'list_flow_building_blocks') {
      assertAllowedArguments(args, ['query', 'include', 'connected']);
      const query = (optionalString(args, 'query', { allowEmpty: true }) ?? '').toLocaleLowerCase();
      const include = optionalStringArray(args, 'include', ['models', 'servers', 'flows']) ?? ['models', 'servers', 'flows'];
      const connected = optionalBoolean(args, 'connected');
      const context = await gatherGenerationContext();
      return textResult({
        ...(include.includes('models')
          ? {
              models: context.blocks.models.filter((model) =>
                !query || `${model.id} ${model.name} ${model.displayName ?? ''} ${model.description ?? ''}`.toLocaleLowerCase().includes(query)),
            }
          : {}),
        ...(include.includes('servers')
          ? {
              servers: context.blocks.servers.filter((server) =>
                (connected === undefined || server.connected === connected) &&
                (!query || `${server.name} ${(server.tools ?? []).map((tool) => `${tool.name} ${tool.description ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(query))),
            }
          : {}),
        ...(include.includes('flows')
          ? {
              flows: context.blocks.flows.filter((flow) =>
                !query || `${flow.id} ${flow.name} ${flow.description ?? ''}`.toLocaleLowerCase().includes(query)),
            }
          : {}),
      });
    }

    if (toolName === 'get_flow_authoring_guide') {
      const profile = args?.profile === 'advanced' ? 'advanced' : 'simple';
      if (profile === 'advanced') {
        return textResult({ profile, guide: FLOWSPEC_DOC });
      }
      return textResult({
        profile,
        schema: SIMPLE_FLOW_SPEC_SCHEMA,
        guide: [
          'Set name, goal, and one or more ordered steps.',
          'Each step needs id and task. model overrides the top-level default.',
          'Tools use server/tool references from list_flow_building_blocks.',
          'Set flow on a step to run an existing flow instead of a model.',
          'Omit routes for a linear flow. Routes are only for branches; omit when for the fallback.',
          'Start, Finish, layout, data handoff, and ordinary defaults are inferred.',
        ],
      });
    }

    if (toolName === 'suggest_tools_for_flow_step') {
      if (!isFlow(args.flow) || typeof args.nodeId !== 'string' || typeof args.modelId !== 'string') {
        return textResult({ error: 'flow, nodeId, and modelId are required.' }, true);
      }
      return textResult(await suggestToolsForFlowStep({
        flow: args.flow,
        nodeId: args.nodeId,
        modelId: args.modelId,
        goal: typeof args.goal === 'string' ? args.goal : undefined,
      }));
    }

    if (toolName === 'apply_tools_to_flow_step') {
      if (!isFlow(args.flow) || typeof args.nodeId !== 'string' || !Array.isArray(args.selections)) {
        return textResult({ error: 'flow, nodeId, and selections are required.' }, true);
      }
      const selections = args.selections.filter((selection): selection is StepToolSuggestion =>
        !!selection && typeof selection === 'object'
        && typeof (selection as StepToolSuggestion).server === 'string'
        && typeof (selection as StepToolSuggestion).tool === 'string'
        && typeof (selection as StepToolSuggestion).reason === 'string');
      return textResult({
        saved: false,
        flow: await applyToolsToFlowStep({
          flow: args.flow,
          nodeId: args.nodeId,
          selections,
          proposedPrompt: typeof args.proposedPrompt === 'string' ? args.proposedPrompt : undefined,
        }),
      });
    }

    if (toolName === 'check_flow_plausibility') {
      if (!isFlow(args.flow)) return textResult({ error: 'A complete flow is required.' }, true);
      return textResult(await checkFlowPlausibility({
        flow: args.flow,
        relatedFlows: Array.isArray(args.relatedFlows) ? args.relatedFlows.filter(isFlow) : undefined,
        modelId: typeof args.modelId === 'string' ? args.modelId : undefined,
        intendedContext: args.intendedContext === 'headless' ? 'headless' : 'chat',
      }));
    }

    if (toolName === 'search_mcp_marketplace') {
      const query = typeof args?.query === 'string' ? args.query : '';
      const hits = await searchRegistry(query);
      return textResult(hits);
    }

    if (toolName === 'install_mcp_server') {
      const name = typeof args?.name === 'string' ? args.name : '';
      const env =
        args?.env && typeof args.env === 'object' && !Array.isArray(args.env)
          ? (args.env as Record<string, string>)
          : undefined;

      // SEP-1024: resolve WITHOUT spawning first, so the exact command/args can be
      // shown/logged/approved before anything runs.
      const resolved = await installRegistryServer(name, env, { resolveOnly: true });
      if (!resolved.plan) {
        // Couldn't resolve to a runnable entry (bad name / unsupported / lookup error).
        return textResult(resolved, true);
      }

      const settings = await loadAutoInstallSettings();
      const decision = decideInstallConsent({ caller: 'authoring-tool', settings, registryName: name });
      const verificationWarning = isVerifiedStatus(resolved.plan.verificationStatus)
        ? undefined
        : `Unverified / self-asserted registry entry (status: ${resolved.plan.verificationStatus}). Registry entries are publisher-asserted — review the command before approving.`;

      // Audit BEFORE any spawn, on every path (trusted or not).
      await appendInstallAudit(planToAuditEntry(resolved.plan, 'authoring-tool', decision, false));

      if (!decision.allowed) {
        // Do NOT spawn: return the resolved plan so the caller can surface it for approval.
        return textResult({
          installed: false,
          consentRequired: true,
          message: decision.message,
          plan: resolved.plan,
          ...(verificationWarning ? { verificationWarning } : {}),
        });
      }

      const result = await installRegistryServer(name, env);
      await appendInstallAudit(
        planToAuditEntry(result.plan ?? resolved.plan, 'authoring-tool', decision, result.installed, result.error)
      );
      return textResult(
        { ...result, ...(verificationWarning ? { verificationWarning } : {}) },
        !result.installed
      );
    }

    if (toolName === 'install_best_mcp_server') {
      const capability = typeof args?.capability === 'string' ? args.capability : '';
      const env =
        args?.env && typeof args.env === 'object' && !Array.isArray(args.env)
          ? (args.env as Record<string, string>)
          : undefined;
      if (!capability) {
        return textResult({ error: 'Provide a "capability" search term.' }, true);
      }

      // Consent for the authoring-tool caller is name-independent (it keys on
      // trustBrainStem), so it can be decided once for the whole ranked walk.
      const settings = await loadAutoInstallSettings();
      const decision = decideInstallConsent({ caller: 'authoring-tool', settings, registryName: capability });

      if (!decision.allowed) {
        // Preview the top-ranked installable candidate's exact command so the
        // caller can obtain approval — never spawn anything.
        const hits = await searchRegistry(capability);
        const top = hits.find((h) => h.installable);
        const preview = top ? await installRegistryServer(top.name, env, { resolveOnly: true }) : null;
        if (preview?.plan) {
          await appendInstallAudit(planToAuditEntry(preview.plan, 'authoring-tool', decision, false));
        }
        return textResult({
          installed: false,
          consentRequired: true,
          message: decision.message,
          ...(preview?.plan ? { plan: preview.plan } : {}),
        });
      }

      // Trusted: walk best→worst with the works-gate, auditing every spawn.
      const result = await installBestForCapability(capability, env, {
        onAttempt: async (plan, res) => {
          if (plan) await appendInstallAudit(planToAuditEntry(plan, 'authoring-tool', decision, res.installed, res.error));
        },
      });
      const verificationWarning =
        result.installed && !isVerifiedStatus(result.plan?.verificationStatus)
          ? `Installed an unverified / self-asserted registry entry (status: ${result.plan?.verificationStatus}).`
          : undefined;
      return textResult(
        { ...result, ...(verificationWarning ? { verificationWarning } : {}) },
        !result.installed
      );
    }

    if (toolName === 'draft_generated_flow') {
      const spec = extractSpec(args);
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return textResult({ error: 'Provide a complete advanced FlowSpec object in "spec".' }, true);
      }
      const context = await gatherGenerationContext();
      const result = compileGeneratedDraft(spec as FlowSpec, context);
      if (!result.success) {
        return textResult({
          error: 'The generated specification could not be compiled.',
          spec: result.spec,
          issues: result.issues,
          hardening: {
            guardChanges: result.guardChanges,
            repairChanges: result.repairChanges,
          },
        }, true);
      }
      return textResult({
        profile: 'advanced',
        pipeline: 'production-generator',
        saved: false,
        rootFlowId: result.flow.id,
        flow: result.flow,
        flows: result.flows.map((entry) => entry.flow),
        spec: result.spec,
        validation: result.validation,
        hardening: {
          guardChanges: result.guardChanges,
          repairChanges: result.repairChanges,
        },
      });
    }

    if (toolName === 'validate_flow_spec' || toolName === 'draft_flow' || toolName === 'create_flow') {
      const spec = extractSpec(args);
      if (!spec) {
        return textResult({ error: 'Provide a "spec" argument: a SimpleFlowSpec object (or JSON string).' }, true);
      }
      const record = spec && typeof spec === 'object' && !Array.isArray(spec)
        ? spec as Record<string, unknown>
        : {};
      const profile = args.profile === 'advanced'
        ? 'advanced'
        : args.profile === 'simple'
          ? 'simple'
          : Array.isArray(record.nodes) && Array.isArray(record.edges)
            ? 'advanced'
            : 'simple';
      const keepPills = args.keepPills === true;
      const result = await compileSpec(spec, {
        save: toolName === 'create_flow',
        keepPills,
        profile,
      });
      if (!result.success) {
        return textResult({ error: result.error, issues: result.issues ?? [] }, true);
      }
      // A spec may nest inline child flows (subflowSpec), so a create can produce several
      // flows at once (root + descendants, saved descendants-first).
      const bundleCount = result.flows.length;
      const subflowNote = bundleCount > 1 ? ` (plus ${bundleCount - 1} nested subflow flow(s))` : '';
      const summary = {
        profile,
        flowId: result.flow.id,
        flowName: result.flow.name,
        nodeCount: result.flow.nodes.length,
        edgeCount: result.flow.edges.length,
        ...(bundleCount > 1 ? { flows: result.flows.map((f) => ({ id: f.id, name: f.name })) } : {}),
        validation: result.validation,
        ...(toolName === 'draft_flow'
          ? {
              saved: false,
              rootFlowId: result.flow.id,
              flow: result.flow,
              flows: result.flows,
            }
          : {}),
        ...(toolName === 'create_flow'
          ? {
              saved: result.saved,
              ...(result.saved
                ? { note: `Flow "${result.flow.name}"${subflowNote} was created. It is callable as a tool on this MCP server (after a fresh tools/list) and as model "flow-${result.flow.name}" on the OpenAI-compatible endpoint.` }
                : { note: 'NOT saved: validation found errors. Fix the issues and call create_flow again.' }),
            }
          : {}),
      };
      // create_flow that could not save is an error outcome for the caller's loop.
      return textResult(summary, toolName === 'create_flow' && !result.saved);
    }

    return textResult({ error: `Unknown authoring tool: ${toolName}` }, true);
  } catch (err) {
    log.error('authoringCallTool failed', { toolName, err });
    return textResult(
      { error: `Authoring tool failed: ${err instanceof Error ? err.message : String(err)}` },
      true
    );
  }
}
