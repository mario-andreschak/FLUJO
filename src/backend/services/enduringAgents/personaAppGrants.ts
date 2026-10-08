import { loadServerConfigs } from '@/backend/services/mcp/config';
import {
  CreatePersonaAppGrantInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  EnduringAgentIdSchema,
  PersonaAppGrantSchema,
  PersonaAppLaunchInputSchema,
  PersonaSchema,
  ReplacePersonaAppGrantInputSchema,
  type CreatePersonaAppGrantInput,
  type Persona,
  type PersonaAppGrant,
  type PersonaAppLaunchDescriptor,
  type PersonaAppLaunchInput,
  type ReplacePersonaAppGrantInput,
} from '@/shared/types/enduringAgent';
import type { MCPServerConfig } from '@/shared/types/mcp';

import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
} from './domainMutation';
import { personaAppGrantId } from './ids';
import { authorizePersonaCoreAppAccess } from './personaCoreApps';
import {
  withPersonaRuntimeLock,
  type PersonaRuntimeLock,
} from './runtimeLock';
import {
  createPersonaAppGrant,
  deletePersonaAppGrantRecord,
  getPersona,
  getPersonaAppGrant,
  getPersonaDeletionTombstone,
  listPersonaAppGrants,
  updatePersonaAppGrant,
  updatePersonaWithinRuntimeLock,
} from './store';

async function requireWritablePersona(personaId: string): Promise<Persona> {
  const persona = await getPersona(personaId);
  if (!persona || await getPersonaDeletionTombstone(personaId)) {
    throw new PersonaDomainNotFoundError('Persona', personaId);
  }
  return persona;
}

async function syncPersonaSelection(
  persona: Persona,
  mcpServerName: string,
  selected: boolean,
  lock: PersonaRuntimeLock,
): Promise<void> {
  const fallbackRefs = persona.composition?.appRefs ?? (
    await listPersonaAppGrants(persona.id)
  ).map((grant) => grant.mcpServerName);
  const current = Array.from(new Set(fallbackRefs));
  const appRefs = selected
    ? current.includes(mcpServerName) ? current : [...current, mcpServerName]
    : current.filter((reference) => reference !== mcpServerName);
  if (appRefs.length === current.length && appRefs.every((reference, index) => reference === current[index])) {
    return;
  }
  await updatePersonaWithinRuntimeLock(PersonaSchema.parse({
    ...persona,
    composition: { ...persona.composition, appRefs },
    updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
  }), lock);
}

async function requireSelectableMcpConfig(mcpServerName: string): Promise<MCPServerConfig> {
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
  return config;
}

async function requireDirectAppConfig(mcpServerName: string): Promise<MCPServerConfig> {
  const config = await requireSelectableMcpConfig(mcpServerName);
  if (config.enableMcpApps !== true) {
    throw new PersonaDomainConflictError(
      `MCP Apps are not enabled for config ${JSON.stringify(mcpServerName)}.`,
    );
  }
  return config;
}

/**
 * Select one exact named MCP config for the Persona Core. Configs that publish
 * an App UI can also be launched, but ordinary tool-only servers are valid
 * selections. Flow snapshots and bindings remain untouched.
 */
export async function grantPersonaAppAccess(
  personaId: string,
  value: unknown,
): Promise<PersonaAppGrant> {
  EnduringAgentIdSchema.parse(personaId);
  const input = CreatePersonaAppGrantInputSchema.parse(value) as CreatePersonaAppGrantInput;
  await requireSelectableMcpConfig(input.mcpServerName);

  return withPersonaRuntimeLock(personaId, async (lock) => {
    const persona = await requireWritablePersona(personaId);
    const id = personaAppGrantId(personaId, input.mcpServerName);
    const existing = await getPersonaAppGrant(id);
    if (existing) {
      if (
        existing.personaId === personaId
        && existing.mcpServerName === input.mcpServerName
      ) {
        await syncPersonaSelection(persona, input.mcpServerName, true, lock);
        return existing;
      }
      throw new PersonaDomainConflictError('Persona app grant identity collision.');
    }
    const now = Date.now();
    const grant = await createPersonaAppGrant(PersonaAppGrantSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId,
      mcpServerName: input.mcpServerName,
      ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
      ...(input.toolParameterPresets !== undefined
        ? { toolParameterPresets: input.toolParameterPresets }
        : {}),
      createdAt: now,
      updatedAt: now,
    }));
    await syncPersonaSelection(persona, input.mcpServerName, true, lock);
    return grant;
  });
}

/**
 * Replace one exact configuration under the Persona runtime lock. The target is
 * validated before persistence and a stale client cannot overwrite a newer
 * selection. Retrying the already-applied target is idempotent only while the
 * caller's expected timestamp still matches.
 */
export async function replacePersonaAppAccess(
  personaId: string,
  grantId: string,
  value: unknown,
): Promise<PersonaAppGrant> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(grantId);
  const input = ReplacePersonaAppGrantInputSchema.parse(value) as ReplacePersonaAppGrantInput;

  return withPersonaRuntimeLock(personaId, async (lock) => {
    const persona = await requireWritablePersona(personaId);
    const grant = await getPersonaAppGrant(grantId);
    if (!grant || grant.personaId !== personaId) {
      throw new PersonaDomainNotFoundError('PersonaAppGrant', grantId);
    }
    if (grant.updatedAt !== input.expectedUpdatedAt) {
      throw new PersonaDomainConflictError(
        'The Persona App selection changed in another request.',
        'PERSONA_APP_STALE_WRITE',
        { currentUpdatedAt: grant.updatedAt },
      );
    }

    // Revalidate inside the lock so a failed target never removes the working App.
    await requireSelectableMcpConfig(input.mcpServerName);
    if (grant.mcpServerName === input.mcpServerName) {
      if (input.enabledTools === undefined && input.toolParameterPresets === undefined) return grant;
      const updated = PersonaAppGrantSchema.parse({
        ...grant,
        ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
        ...(input.toolParameterPresets !== undefined
          ? { toolParameterPresets: input.toolParameterPresets }
          : {}),
        updatedAt: Math.max(Date.now(), grant.updatedAt + 1),
      });
      return updatePersonaAppGrant(updated);
    }

    const replacementId = personaAppGrantId(personaId, input.mcpServerName);
    if (await getPersonaAppGrant(replacementId)) {
      throw new PersonaDomainConflictError(
        'That MCP configuration is already selected for this Persona.',
        'PERSONA_APP_ALREADY_SELECTED',
      );
    }

    const now = Math.max(Date.now(), grant.updatedAt + 1);
    const replacement = PersonaAppGrantSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id: replacementId,
      personaId,
      mcpServerName: input.mcpServerName,
      ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
      ...(input.toolParameterPresets !== undefined
        ? { toolParameterPresets: input.toolParameterPresets }
        : {}),
      createdAt: grant.createdAt,
      updatedAt: now,
    });
    let createdReplacement = false;
    let updatedSelection = false;
    try {
      await createPersonaAppGrant(replacement);
      createdReplacement = true;
      const currentRefs = Array.from(new Set(
        persona.composition?.appRefs ?? (
          await listPersonaAppGrants(personaId)
        ).map((candidate) => candidate.mcpServerName),
      ));
      const nextRefs = currentRefs.map((reference) => (
        reference === grant.mcpServerName ? input.mcpServerName : reference
      ));
      if (!nextRefs.includes(input.mcpServerName)) nextRefs.push(input.mcpServerName);
      const appRefs = Array.from(new Set(nextRefs.filter(
        (reference) => reference !== grant.mcpServerName,
      )));
      await updatePersonaWithinRuntimeLock(PersonaSchema.parse({
        ...persona,
        composition: { ...persona.composition, appRefs },
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      }), lock);
      updatedSelection = true;
      await deletePersonaAppGrantRecord(grant.id);
      return replacement;
    } catch (error) {
      // Best-effort rollback keeps the previously working exact configuration.
      if (updatedSelection) {
        await updatePersonaWithinRuntimeLock(PersonaSchema.parse({
          ...persona,
          updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
        }), lock).catch(() => undefined);
      }
      if (createdReplacement) {
        await deletePersonaAppGrantRecord(replacement.id).catch(() => undefined);
      }
      throw error;
    }
  });
}

/** Grant removal bypasses the Activity lease; later launcher authorizations fail closed. */
export async function revokePersonaAppAccess(
  personaId: string,
  grantId: string,
): Promise<void> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(grantId);
  await withPersonaRuntimeLock(personaId, async (lock) => {
    const persona = await requireWritablePersona(personaId);
    const grant = await getPersonaAppGrant(grantId);
    // Return the same 404 for missing and foreign records: never reveal another
    // Persona's device inventory through a confused-deputy request.
    if (!grant || grant.personaId !== personaId) {
      throw new PersonaDomainNotFoundError('PersonaAppGrant', grantId);
    }
    await deletePersonaAppGrantRecord(grant.id);
    await syncPersonaSelection(persona, grant.mcpServerName, false, lock);
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
    await authorizePersonaCoreAppAccess(
      personaId,
      [grant.mcpServerName],
      grant.mcpServerName,
    );
    // Core tool authorization deliberately accepts any enabled MCP server;
    // opening a sandboxed App UI remains separately opt-in.
    await requireDirectAppConfig(grant.mcpServerName);
    return {
      personaId,
      grantId: grant.id,
      mcpServerName: grant.mcpServerName,
      uri: input.uri,
    };
  });
}
