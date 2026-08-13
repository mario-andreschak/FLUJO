import { createHash } from 'crypto';

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

export const PERSONA_CORE_APP_NODE_PREFIX = 'persona_core_app_';

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

export function requireEnabledPersonaAppConfig(
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
  if (config.enableMcpApps !== true) {
    throw new PersonaDomainConflictError(
      `MCP Apps are not enabled for config ${JSON.stringify(mcpServerName)}.`,
    );
  }
  return config;
}

/**
 * Creation-time Role suggestions are hints only. Missing, disabled, and
 * non-App configs are omitted instead of blocking Persona provisioning.
 */
export async function resolveAvailablePersonaAppRefs(
  references: readonly string[],
): Promise<string[]> {
  if (references.length === 0) return [];
  const configs = await loadConfigs();
  const available = new Set(
    configs
      .filter((config) => config.disabled !== true && config.enableMcpApps === true)
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
  requireEnabledPersonaAppConfig(await loadConfigs(), mcpServerName);
}

function coreNodeId(mcpServerName: string): string {
  const digest = createHash('sha256').update(mcpServerName).digest('hex').slice(0, 16);
  return `${PERSONA_CORE_APP_NODE_PREFIX}${digest}`;
}

export function isPersonaCoreAppNodeId(nodeId: string | undefined): boolean {
  return typeof nodeId === 'string' && nodeId.startsWith(PERSONA_CORE_APP_NODE_PREFIX);
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

    projectedNodes.push({
      id: coreNodeId(mcpServerName),
      properties: {
        boundServer: mcpServerName,
        enabledTools: unique((listed.tools ?? []).map((tool) => tool.name)),
        enabledResources: 'all',
      },
    });
  }

  const flow = structuredClone(source);
  for (const node of flow.nodes) {
    if (node.type !== 'process') continue;
    const data = node.data as typeof node.data & {
      properties?: Record<string, unknown> & { mcpNodes?: MCPNodeReference[] };
    };
    const properties = data.properties ?? {};
    const authoredNodes = Array.isArray(properties.mcpNodes) ? properties.mcpNodes : [];
    const authoredServers = new Set(
      authoredNodes.map((candidate) => candidate.properties.boundServer).filter(Boolean),
    );
    properties.mcpNodes = [
      ...authoredNodes,
      ...projectedNodes.filter(
        (candidate) => !authoredServers.has(candidate.properties.boundServer),
      ),
    ];
    data.properties = properties;
  }
  return flow;
}
