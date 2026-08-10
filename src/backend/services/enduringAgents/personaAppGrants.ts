import { loadServerConfigs } from '@/backend/services/mcp/config';
import {
  CreatePersonaAppGrantInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  EnduringAgentIdSchema,
  PersonaAppGrantSchema,
  PersonaAppLaunchInputSchema,
  type CreatePersonaAppGrantInput,
  type PersonaAppGrant,
  type PersonaAppLaunchDescriptor,
  type PersonaAppLaunchInput,
} from '@/shared/types/enduringAgent';
import type { MCPServerConfig } from '@/shared/types/mcp';

import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
} from './domainMutation';
import { personaAppGrantId } from './ids';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  createPersonaAppGrant,
  deletePersonaAppGrantRecord,
  getPersona,
  getPersonaAppGrant,
  getPersonaDeletionTombstone,
  listPersonaAppGrants,
} from './store';

async function requireWritablePersona(personaId: string): Promise<void> {
  if (!await getPersona(personaId) || await getPersonaDeletionTombstone(personaId)) {
    throw new PersonaDomainNotFoundError('Persona', personaId);
  }
}

async function requireDirectAppConfig(mcpServerName: string): Promise<MCPServerConfig> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) {
    throw new PersonaDomainConflictError(
      configs.error || 'MCP server configurations are currently unavailable.',
    );
  }
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
 * Grant direct launcher access to one exact named config. The live config is
 * checked before persistence, while Flow snapshots and bindings are untouched.
 */
export async function grantPersonaAppAccess(
  personaId: string,
  value: unknown,
): Promise<PersonaAppGrant> {
  EnduringAgentIdSchema.parse(personaId);
  const input = CreatePersonaAppGrantInputSchema.parse(value) as CreatePersonaAppGrantInput;
  await requireDirectAppConfig(input.mcpServerName);

  return withPersonaRuntimeLock(personaId, async () => {
    await requireWritablePersona(personaId);
    const id = personaAppGrantId(personaId, input.mcpServerName);
    const existing = await getPersonaAppGrant(id);
    if (existing) {
      if (
        existing.personaId === personaId
        && existing.mcpServerName === input.mcpServerName
      ) return existing;
      throw new PersonaDomainConflictError('Persona app grant identity collision.');
    }
    const now = Date.now();
    return createPersonaAppGrant(PersonaAppGrantSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId,
      mcpServerName: input.mcpServerName,
      createdAt: now,
      updatedAt: now,
    }));
  });
}

/** Grant removal bypasses the Activity lease; later launcher authorizations fail closed. */
export async function revokePersonaAppAccess(
  personaId: string,
  grantId: string,
): Promise<void> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(grantId);
  await withPersonaRuntimeLock(personaId, async () => {
    await requireWritablePersona(personaId);
    const grant = await getPersonaAppGrant(grantId);
    // Return the same 404 for missing and foreign records: never reveal another
    // Persona's device inventory through a confused-deputy request.
    if (!grant || grant.personaId !== personaId) {
      throw new PersonaDomainNotFoundError('PersonaAppGrant', grantId);
    }
    await deletePersonaAppGrantRecord(grant.id);
  });
}

export async function listPersonaDirectAppGrants(
  personaId: string,
): Promise<PersonaAppGrant[]> {
  EnduringAgentIdSchema.parse(personaId);
  await requireWritablePersona(personaId);
  return listPersonaAppGrants(personaId);
}

/**
 * Re-authorize every Persona launcher click against both grant ownership and
 * current config state. The existing MCP Apps host remains authoritative for
 * resource reads, MIME/CSP validation, consent, and same-server tool calls.
 */
export async function authorizePersonaAppLaunch(
  personaId: string,
  grantId: string,
  value: unknown,
): Promise<PersonaAppLaunchDescriptor> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(grantId);
  const input = PersonaAppLaunchInputSchema.parse(value) as PersonaAppLaunchInput;
  return withPersonaRuntimeLock(personaId, async () => {
    await requireWritablePersona(personaId);
    const grant = await getPersonaAppGrant(grantId);
    if (!grant || grant.personaId !== personaId) {
      throw new PersonaDomainNotFoundError('PersonaAppGrant', grantId);
    }
    await requireDirectAppConfig(grant.mcpServerName);
    return {
      personaId,
      grantId: grant.id,
      mcpServerName: grant.mcpServerName,
      uri: input.uri,
    };
  });
}
