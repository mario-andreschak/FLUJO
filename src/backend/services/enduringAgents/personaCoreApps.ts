import type { Flow } from '@/shared/types/flow';
import type { MCPNodeReference } from '@/backend/execution/flow/types';
import { mcpService } from '@/backend/services/mcp';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { Persona } from '@/shared/types/enduringAgent';

import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
} from './domainMutation';
import {
  getPersona,
  getPersonaDeletionTombstone,
  listPersonaAppGrants,
} from './store';
import {
  isPersonaCoreAppNodeId,
  personaCoreAppNodeId,
  PERSONA_CORE_APP_NODE_PREFIX,
} from './personaCoreAppIdentity';

export {
  isPersonaCoreAppNodeId,
  personaCoreAppNodeId,
  PERSONA_CORE_APP_NODE_PREFIX,
} from './personaCoreAppIdentity';

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

async function loadConfigs(): Promise<MCPServerConfig[]> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) {
    throw new PersonaDomainConflictError(
      configs.error || 'MCP server configurations are currently unavailable.',
    );
  }
  return configs;
}

export function requireEnabledPersonaMcpConfig(
  configs: readonly MCPServerConfig[],
  mcpServerName: string,
): MCPServerConfig {
  const config = configs.find((candidate) => candidate.name === mcpServerName);
  if (!config) throw new PersonaDomainNotFoundError('MCPServerConfig', mcpServerName);
  if (config.disabled === true) {
    throw new PersonaDomainConflictError(
      `MCP config ${JSON.stringify(mcpServerName)} is disabled.`,
    );
  }
  return config;
}

/**
 * Creation-time Role suggestions are hints only. Missing and disabled configs
 * are omitted instead of blocking Persona provisioning. MCP App UI support is
 * not required: Persona Core projection consumes ordinary MCP tools too.
 */
export async function resolveAvailablePersonaAppRefs(
  references: readonly string[],
): Promise<string[]> {
  if (references.length === 0) return [];
  const configs = await loadConfigs();
  const available = new Set(
    configs
      .filter((config) => config.disabled !== true)
      .map((config) => config.name),
  );
  return unique(references).filter((reference) => available.has(reference));
}

async function selectedAppRefs(persona: Persona): Promise<string[]> {
  if (persona.composition?.appRefs) return unique(persona.composition.appRefs);
  return unique(
    (await listPersonaAppGrants(persona.id)).map((grant) => grant.mcpServerName),
  );
}

/**
 * Freeze the exact selected configuration names at Activity admission. This
 * snapshot is capability-free and intentionally contains no credentials,
 * clients, tool handles, or connection state.
 */
export async function snapshotPersonaCoreAppRefs(
  personaId: string,
  knownPersona?: Persona,
): Promise<string[]> {
  const persona = knownPersona ?? await getPersona(personaId);
  if (!persona || persona.id !== personaId || await getPersonaDeletionTombstone(personaId)) {
    throw new PersonaDomainNotFoundError('Persona', personaId);
  }
  const selected = await selectedAppRefs(persona);
  return resolveAvailablePersonaAppRefs(selected);
}

/**
 * Revalidate one projected handle against both its immutable Activity snapshot
 * and the Persona's current editable selection. Exact config-name equality is
 * the workspace-local account identity used throughout the MCP service.
 */
export async function authorizePersonaCoreAppAccess(
  personaId: string,
  frozenAppRefs: readonly string[],
  mcpServerName: string,
): Promise<void> {
  if (!frozenAppRefs.includes(mcpServerName)) {
    throw new PersonaDomainConflictError(
      `MCP config ${JSON.stringify(mcpServerName)} was not projected into this Activity.`,
    );
  }
  const persona = await getPersona(personaId);
  if (!persona || persona.id !== personaId || await getPersonaDeletionTombstone(personaId)) {
    throw new PersonaDomainNotFoundError('Persona', personaId);
  }
  const selected = await selectedAppRefs(persona);
  if (!selected.includes(mcpServerName)) {
    throw new PersonaDomainConflictError(
      `Persona App ${JSON.stringify(mcpServerName)} is no longer selected.`,
    );
  }
  requireEnabledPersonaMcpConfig(await loadConfigs(), mcpServerName);
}

function authoredMcpServersByProcess(source: Flow): Map<string, Set<string>> {
  const byNodeId = new Map(source.nodes.map((node) => [node.id, node]));
  const result = new Map<string, Set<string>>();

  for (const edge of source.edges) {
    if ((edge.data as { edgeType?: unknown } | undefined)?.edgeType !== 'mcp') continue;
    const left = byNodeId.get(edge.source);
    const right = byNodeId.get(edge.target);
    if (!left || !right) continue;

    const process = left.type === 'process'
      ? left
      : right.type === 'process' ? right : undefined;
    const mcp = left.type === 'mcp'
      ? left
      : right.type === 'mcp' ? right : undefined;
    const boundServer = mcp?.data?.properties?.boundServer;
    if (!process || typeof boundServer !== 'string' || !boundServer) continue;

    const servers = result.get(process.id) ?? new Set<string>();
    servers.add(boundServer);
    result.set(process.id, servers);
  }

  return result;
}

/**
 * Project selected Apps into a cloned Persona Core Flow. The persisted Behavior
 * revision is never changed. Existing authored MCP nodes win for the same exact
 * server so their enabledTools/resource policy remains authoritative.
 */
export async function projectPersonaCoreAppsIntoFlow(
  personaId: string,
  frozenAppRefs: readonly string[],
  source: Flow,
): Promise<Flow> {
  if (frozenAppRefs.length === 0) return structuredClone(source);

  const grantsByServer = new Map(
    (await listPersonaAppGrants(personaId)).map((grant) => [grant.mcpServerName, grant]),
  );
  const projectedNodes: MCPNodeReference[] = [];
  for (const mcpServerName of unique(frozenAppRefs)) {
    await authorizePersonaCoreAppAccess(personaId, frozenAppRefs, mcpServerName);

    const connected = await mcpService.connectServer(mcpServerName);
    if (!connected.success) {
      throw new PersonaDomainConflictError(
        `Failed to connect to Persona App ${JSON.stringify(mcpServerName)}: ${connected.error ?? 'unknown MCP error'}`,
      );
    }
    const listed = await mcpService.listServerTools(mcpServerName);
    if (listed.error) {
      throw new PersonaDomainConflictError(
        `Failed to list tools for Persona App ${JSON.stringify(mcpServerName)}: ${listed.error}`,
      );
    }

    const liveToolNames = unique((listed.tools ?? []).map((tool) => tool.name));
    const grant = grantsByServer.get(mcpServerName);
    const enabledTools = grant?.enabledTools === undefined
      ? liveToolNames
      : grant.enabledTools.filter((toolName) => liveToolNames.includes(toolName));
    projectedNodes.push({
      id: personaCoreAppNodeId(mcpServerName),
      properties: {
        boundServer: mcpServerName,
        enabledTools,
        ...(grant?.toolParameterPresets !== undefined
          ? { toolParameterPresets: grant.toolParameterPresets }
          : {}),
        enabledResources: 'all',
      },
    });
  }

  const flow = structuredClone(source);
  const authoredServersByProcess = authoredMcpServersByProcess(source);
  for (const node of flow.nodes) {
    if (node.type !== 'process') continue;
    const data = node.data as typeof node.data & {
      properties?: Record<string, unknown> & { mcpNodes?: MCPNodeReference[] };
    };
    const properties = data.properties ?? {};
    // Behavior snapshots strip derived inline references, so graph-native MCP
    // attachment edges are the authoritative authored policy. Non-Persona
    // inline references remain intact here for compatibility, but the converter
    // still rejects them unless graph edges re-derive them.
    const authoredNodes = Array.isArray(properties.mcpNodes)
      ? properties.mcpNodes.filter((candidate) => !isPersonaCoreAppNodeId(candidate.id))
      : [];
    // Only visible graph wiring is authored policy. Legacy inline references
    // are derived/stale data: preserve them for source compatibility, but never
    // let one suppress the runtime projection that the converter can authorize.
    const authoredServers = authoredServersByProcess.get(node.id) ?? new Set<string>();
    properties.mcpNodes = [
      ...authoredNodes,
      ...projectedNodes.filter(
        (candidate) => {
          const boundServer = candidate.properties.boundServer;
          return typeof boundServer === 'string' && !authoredServers.has(boundServer);
        },
      ),
    ];
    data.properties = properties;
  }
  return flow;
}
