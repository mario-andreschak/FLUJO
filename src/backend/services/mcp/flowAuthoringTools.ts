/**
 * Flow-authoring tools for the built-in FLUJO MCP server (#14 follow-up:
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
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { gatherGenerationContext } from '@/backend/services/flow/generationContext';
import { searchRegistry, installRegistryServer, installBestForCapability } from '@/backend/services/mcp/registryInstall';
import { loadAutoInstallSettings, appendInstallAudit } from '@/backend/services/mcp/autoInstall';
import { decideInstallConsent, planToAuditEntry } from '@/utils/mcp/autoInstallConsent';
import { isVerifiedStatus } from '@/utils/mcp/registry';

const log = createLogger('backend/services/mcp/flowAuthoringTools');

export const AUTHORING_TOOL_NAMES = [
  'list_flow_building_blocks',
  'validate_flow_spec',
  'create_flow',
  'search_mcp_marketplace',
  'install_mcp_server',
  'install_best_mcp_server',
] as const;

export function isAuthoringTool(name: string): boolean {
  return (AUTHORING_TOOL_NAMES as readonly string[]).includes(name);
}

/** JSON Schema for the spec-taking tools: one object argument. */
function specInputSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'The FlowSpec object (see the tool description for the format).',
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
        'List everything a FlowSpec may reference in this FLUJO instance: configured models (bind to process steps), MCP servers and their tools (attach via "servers"), and existing flows (usable as subflow targets). Call this before authoring a spec.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'validate_flow_spec',
      description: `Compile and validate a FlowSpec WITHOUT saving. Returns the compiled flow's validation result (errors block saving; warnings are advisory) so you can iterate until clean, then call create_flow.\n\n${FLOWSPEC_DOC}`,
      inputSchema: specInputSchema(),
    },
    {
      name: 'create_flow',
      description: `Create a new FLUJO flow from a FlowSpec. The spec is compiled deterministically (layout, ids, and wiring are generated for you) and saved ONLY when validation finds zero errors — otherwise the issues are returned to fix. Use list_flow_building_blocks first to see the models, MCP servers/tools, and existing flows you may reference.\n\n${FLOWSPEC_DOC}`,
      inputSchema: specInputSchema(),
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
    if (toolName === 'list_flow_building_blocks') {
      const context = await gatherGenerationContext();
      return textResult(context.blocks);
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

    if (toolName === 'validate_flow_spec' || toolName === 'create_flow') {
      const spec = extractSpec(args);
      if (!spec) {
        return textResult({ error: 'Provide a "spec" argument: a FlowSpec object (or a JSON string of one).' }, true);
      }
      const result = await compileSpec(spec, { save: toolName === 'create_flow' });
      if (!result.success) {
        return textResult({ error: result.error, issues: result.issues ?? [] }, true);
      }
      // A spec may nest inline child flows (subflowSpec), so a create can produce several
      // flows at once (root + descendants, saved descendants-first).
      const bundleCount = result.flows.length;
      const subflowNote = bundleCount > 1 ? ` (plus ${bundleCount - 1} nested subflow flow(s))` : '';
      const summary = {
        flowId: result.flow.id,
        flowName: result.flow.name,
        nodeCount: result.flow.nodes.length,
        edgeCount: result.flow.edges.length,
        ...(bundleCount > 1 ? { flows: result.flows.map((f) => ({ id: f.id, name: f.name })) } : {}),
        validation: result.validation,
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
