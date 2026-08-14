import { loadServerConfigs } from '@/backend/services/mcp/config';
import {
  CreatePublicRoleInputSchema,
  DuplicatePublicRoleInputSchema,
  PublicRoleSchema,
  PublicRoleVersionSchema,
  RoleDefinitionSchema,
  RoleImpactPreviewSchema,
  RoleLifecycleInputSchema,
  ROLE_DEFINITION_SCHEMA_VERSION,
  ROLE_VERSION_SCHEMA_VERSION,
  RestorePublicRoleInputSchema,
  RollbackPublicRoleInputSchema,
  RoleVersionSchema,
  UpdatePublicRoleInputSchema,
  type CreatePublicRoleInput,
  type DuplicatePublicRoleInput,
  type PublicRole,
  type PublicRoleSuggestedApp,
  type PublicRoleVersion,
  type RoleDefinition,
  type RoleImpactPreview,
  type RoleLifecycleInput,
  type RestorePublicRoleInput,
  type RollbackPublicRoleInput,
  type RoleSuggestedAppReference,
  type RoleVersion,
  type UpdatePublicRoleInput,
} from '@/shared/types/enduringAgent';

import { BUILT_IN_DEVELOPER_ROLE_ID } from './builtInDeveloperRole';
import { randomEnduringAgentId } from './ids';
import { buildDefaultRoleBehaviorSlots } from './roleBehaviorDefaults';
import { withRoleDefinitionRuntimeLock } from './runtimeLock';
import {
  createRoleVersion,
  deleteRoleDefinitionRecord,
  deleteRoleVersionRecord,
  getRoleDefinition,
  listPersonasStrict,
  listRoleDefinitionsStrict,
  listRoleVersionsStrict,
  saveRoleDefinition,
} from './store';

export class RoleAdminNotFoundError extends Error {
  readonly code = 'ROLE_ADMIN_NOT_FOUND' as const;

  constructor(readonly roleId: string) {
    super(`Role ${JSON.stringify(roleId)} was not found.`);
    this.name = 'RoleAdminNotFoundError';
  }
}

export interface RoleAdminConflictDetails {
  reason?: 'STALE_CURRENT_VERSION' | 'BUILT_IN_ROLE' | 'PERSONA_REFERENCES' | 'ARCHIVED_ROLE';
  personaCount?: number;
  personaIds?: string[];
}

export class RoleAdminConflictError extends Error {
  readonly code = 'ROLE_ADMIN_CONFLICT' as const;

  constructor(
    message: string,
    readonly details?: RoleAdminConflictDetails,
  ) {
    super(message);
    this.name = 'RoleAdminConflictError';
  }
}

interface RoleState {
  definition: RoleDefinition;
  versions: RoleVersion[];
  current: RoleVersion;
}

function roleLock<T>(roleId: string, task: () => Promise<T>): Promise<T> {
  return withRoleDefinitionRuntimeLock(roleId, task);
}

function assertMutableRole(roleId: string): void {
  if (roleId === BUILT_IN_DEVELOPER_ROLE_ID) {
    throw new RoleAdminConflictError(
      'The built-in Developer Role cannot be changed, archived, or deleted.',
      { reason: 'BUILT_IN_ROLE' },
    );
  }
}

function staleVersionConflict(): RoleAdminConflictError {
  return new RoleAdminConflictError(
    'This Role changed since it was read. Reload it and try again.',
    { reason: 'STALE_CURRENT_VERSION' },
  );
}

function roleDescription(prompt: string): string {
  return prompt.slice(0, 10_000);
}

function selectCurrentVersion(
  definition: RoleDefinition,
  versions: RoleVersion[],
): RoleVersion {
  if (versions.length === 0) {
    throw new RoleAdminConflictError(
      `Role ${JSON.stringify(definition.id)} has no readable versions.`,
    );
  }
  if (definition.currentVersionId) {
    const selected = versions.find((version) => version.id === definition.currentVersionId);
    if (!selected) {
      throw new RoleAdminConflictError(
        `Role ${JSON.stringify(definition.id)} points at missing current version `
        + `${JSON.stringify(definition.currentVersionId)}.`,
      );
    }
    return selected;
  }
  return [...versions].sort(
    (left, right) => right.version - left.version || right.createdAt - left.createdAt,
  )[0];
}

async function readRoleState(roleId: string): Promise<RoleState | null> {
  const definition = await getRoleDefinition(roleId);
  if (!definition) return null;
  const versions = await listRoleVersionsStrict(roleId);
  return {
    definition,
    versions,
    current: selectCurrentVersion(definition, versions),
  };
}

async function requireRoleState(roleId: string): Promise<RoleState> {
  const state = await readRoleState(roleId);
  if (!state) throw new RoleAdminNotFoundError(roleId);
  return state;
}

async function installedAppStatuses(): Promise<Map<string, PublicRoleSuggestedApp['status']>> {
  const configs = await loadServerConfigs();
  const statuses = new Map<string, PublicRoleSuggestedApp['status']>();
  if (!Array.isArray(configs)) return statuses;
  for (const config of configs) {
    statuses.set(
      config.name,
      config.disabled === true
        ? 'disabled'
        : config.enableMcpApps === true
          ? 'available'
          : 'apps_disabled',
    );
  }
  return statuses;
}

function resolveSuggestedApps(
  references: readonly RoleSuggestedAppReference[] | undefined,
  statuses: ReadonlyMap<string, PublicRoleSuggestedApp['status']>,
): PublicRoleSuggestedApp[] {
  return (references ?? []).map(({ mcpServerName }) => ({
    mcpServerName,
    status: statuses.get(mcpServerName) ?? 'missing',
  }));
}

function projectRole(
  state: RoleState,
  statuses: ReadonlyMap<string, PublicRoleSuggestedApp['status']>,
): PublicRole {
  return PublicRoleSchema.parse({
    id: state.definition.id,
    name: state.definition.name,
    prompt: state.current.mission,
    suggestedApps: resolveSuggestedApps(state.current.suggestedApps, statuses),
    behaviors: state.current.behaviorSlots.map(({ key, name, description }) => ({
      key,
      name,
      ...(description ? { description } : {}),
    })),
    archived: state.definition.archivedAt !== undefined,
    currentVersionId: state.current.id,
    createdAt: state.definition.createdAt,
    updatedAt: state.definition.updatedAt,
  });
}

export async function listPublicRoles(options: {
  includeArchived?: boolean;
} = {}): Promise<PublicRole[]> {
  const definitions = await listRoleDefinitionsStrict();
  const statuses = await installedAppStatuses();
  const roles = await Promise.all(definitions.map(async (definition) => {
    if (!options.includeArchived && definition.archivedAt !== undefined) return null;
    const versions = await listRoleVersionsStrict(definition.id);
    return projectRole({
      definition,
      versions,
      current: selectCurrentVersion(definition, versions),
    }, statuses);
  }));
  return roles.filter((role): role is PublicRole => role !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function getPublicRole(roleId: string): Promise<PublicRole> {
  const [state, statuses] = await Promise.all([
    requireRoleState(roleId),
    installedAppStatuses(),
  ]);
  return projectRole(state, statuses);
}

export async function createPublicRole(value: unknown): Promise<PublicRole> {
  const input = CreatePublicRoleInputSchema.parse(value) as CreatePublicRoleInput;
  const roleId = input.id ?? randomEnduringAgentId('role');

  return roleLock(roleId, async () => {
    if (await getRoleDefinition(roleId)) {
      throw new RoleAdminConflictError(`Role ${JSON.stringify(roleId)} already exists.`);
    }

    const now = Date.now();
    const versionId = randomEnduringAgentId('rolever');
    const definition = RoleDefinitionSchema.parse({
      schemaVersion: ROLE_DEFINITION_SCHEMA_VERSION,
      id: roleId,
      name: input.name,
      description: roleDescription(input.prompt),
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    });
    const version = RoleVersionSchema.parse({
      schemaVersion: ROLE_VERSION_SCHEMA_VERSION,
      id: versionId,
      roleDefinitionId: roleId,
      version: 1,
      name: input.name,
      mission: input.prompt,
      suggestedApps: input.suggestedApps,
      behaviorSlots: buildDefaultRoleBehaviorSlots(roleId, input.name),
      createdAt: now,
    });

    await saveRoleDefinition(definition);
    try {
      await createRoleVersion(version);
    } catch (error) {
      if ((await listRoleVersionsStrict(roleId)).length === 0) {
        await deleteRoleDefinitionRecord(roleId);
      }
      throw error;
    }
    return getPublicRole(roleId);
  });
}

export async function updatePublicRole(
  roleId: string,
  value: unknown,
): Promise<PublicRole> {
  const input = UpdatePublicRoleInputSchema.parse(value) as UpdatePublicRoleInput;
  assertMutableRole(roleId);
  return roleLock(roleId, async () => {
    const state = await requireRoleState(roleId);
    if (state.definition.archivedAt !== undefined) {
      throw new RoleAdminConflictError(
        'Archived Roles cannot be edited.',
        { reason: 'ARCHIVED_ROLE' },
      );
    }
    if (state.current.id !== input.expectedCurrentVersionId) {
      throw staleVersionConflict();
    }

    const nextOrdinal = Math.max(...state.versions.map((version) => version.version)) + 1;
    const now = Date.now();
    const versionId = randomEnduringAgentId('rolever');
    const name = input.name ?? state.definition.name;
    const nextVersion = RoleVersionSchema.parse({
      ...state.current,
      id: versionId,
      version: nextOrdinal,
      name,
      mission: input.prompt ?? state.current.mission,
      suggestedApps: input.suggestedApps ?? state.current.suggestedApps,
      migrationNotes: undefined,
      createdAt: now,
    });

    await createRoleVersion(nextVersion);
    await saveRoleDefinition(RoleDefinitionSchema.parse({
      ...state.definition,
      name,
      description: roleDescription(input.prompt ?? state.definition.description ?? state.current.mission),
      currentVersionId: nextVersion.id,
      updatedAt: now,
    }));
    return getPublicRole(roleId);
  });
}

export async function duplicatePublicRole(
  sourceRoleId: string,
  value: unknown,
): Promise<PublicRole> {
  const input = DuplicatePublicRoleInputSchema.parse(value ?? {}) as DuplicatePublicRoleInput;
  const source = await requireRoleState(sourceRoleId);
  const roleId = randomEnduringAgentId('role');

  return roleLock(roleId, async () => {
    const now = Date.now();
    const versionId = randomEnduringAgentId('rolever');
    const name = input.name ?? `${source.definition.name} copy`;
    const definition = RoleDefinitionSchema.parse({
      schemaVersion: ROLE_DEFINITION_SCHEMA_VERSION,
      id: roleId,
      name,
      description: roleDescription(source.definition.description ?? source.current.mission),
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    });
    const version = RoleVersionSchema.parse({
      ...source.current,
      id: versionId,
      roleDefinitionId: roleId,
      version: 1,
      name,
      behaviorSlots: buildDefaultRoleBehaviorSlots(roleId, name),
      migrationNotes: `Duplicated from Role ${sourceRoleId}.`,
      createdAt: now,
    });
    await saveRoleDefinition(definition);
    try {
      await createRoleVersion(version);
    } catch (error) {
      if ((await listRoleVersionsStrict(roleId)).length === 0) {
        await deleteRoleDefinitionRecord(roleId);
      }
      throw error;
    }
    return getPublicRole(roleId);
  });
}

export async function rollbackPublicRole(
  roleId: string,
  value: unknown,
): Promise<PublicRole> {
  const input = RollbackPublicRoleInputSchema.parse(value) as RollbackPublicRoleInput;
  assertMutableRole(roleId);
  return roleLock(roleId, async () => {
    const state = await requireRoleState(roleId);
    if (state.definition.archivedAt !== undefined) {
      throw new RoleAdminConflictError('Archived Roles cannot be changed.', { reason: 'ARCHIVED_ROLE' });
    }
    if (state.current.id !== input.expectedCurrentVersionId) throw staleVersionConflict();
    const source = state.versions.find((version) => version.id === input.sourceVersionId);
    if (!source) throw new RoleAdminNotFoundError(input.sourceVersionId);
    const now = Date.now();
    const nextVersion = RoleVersionSchema.parse({
      ...source,
      id: randomEnduringAgentId('rolever'),
      version: Math.max(...state.versions.map((version) => version.version)) + 1,
      migrationNotes: `Restored content from Role version ${source.version}.`,
      createdAt: now,
    });
    await createRoleVersion(nextVersion);
    await saveRoleDefinition(RoleDefinitionSchema.parse({
      ...state.definition,
      name: source.name,
      description: roleDescription(source.mission),
      currentVersionId: nextVersion.id,
      updatedAt: now,
    }));
    return getPublicRole(roleId);
  });
}

export async function restorePublicRole(roleId: string, value: unknown): Promise<PublicRole> {
  const input = RestorePublicRoleInputSchema.parse(value) as RestorePublicRoleInput;
  assertMutableRole(roleId);
  return roleLock(roleId, async () => {
    const state = await requireRoleState(roleId);
    if (state.current.id !== input.expectedCurrentVersionId) throw staleVersionConflict();
    if (state.definition.archivedAt === undefined) return getPublicRole(roleId);
    const activeDefinition: RoleDefinition = { ...state.definition };
    delete activeDefinition.archivedAt;
    await saveRoleDefinition(RoleDefinitionSchema.parse({
      ...activeDefinition,
      currentVersionId: state.current.id,
      updatedAt: Date.now(),
    }));
    return getPublicRole(roleId);
  });
}

export async function listPublicRoleVersions(roleId: string): Promise<PublicRoleVersion[]> {
  const [state, statuses] = await Promise.all([
    requireRoleState(roleId),
    installedAppStatuses(),
  ]);
  return [...state.versions]
    .sort((left, right) => right.version - left.version)
    .map((version) => PublicRoleVersionSchema.parse({
      id: version.id,
      roleId: state.definition.id,
      version: version.version,
      name: version.name,
      prompt: version.mission,
      suggestedApps: resolveSuggestedApps(version.suggestedApps, statuses),
      behaviors: version.behaviorSlots.map(({ key, name, description }) => ({
        key,
        name,
        ...(description ? { description } : {}),
      })),
      createdAt: version.createdAt,
      current: version.id === state.current.id,
    }));
}

export async function previewRoleImpact(roleId: string): Promise<RoleImpactPreview> {
  const state = await requireRoleState(roleId);
  const versionIds = new Set(state.versions.map((version) => version.id));
  const personas = (await listPersonasStrict())
    .filter((persona) => versionIds.has(persona.roleVersionId))
    .sort((left, right) => left.id.localeCompare(right.id));
  const pinnedRoleVersionIds = [...new Set(personas.map((persona) => persona.roleVersionId))].sort();
  return RoleImpactPreviewSchema.parse({
    roleId,
    personaIds: personas.map((persona) => persona.id),
    personaCount: personas.length,
    pinnedRoleVersionIds,
    hardDeleteAllowed: personas.length === 0,
    safeAction: 'archive',
  });
}

export async function archivePublicRole(
  roleId: string,
  value: unknown,
): Promise<PublicRole> {
  const input = RoleLifecycleInputSchema.parse(value) as RoleLifecycleInput & {
    action: 'archive' | 'delete';
  };
  assertMutableRole(roleId);
  if (input.action !== 'archive') {
    throw new RoleAdminConflictError('Archive operation requires action "archive".');
  }
  return roleLock(roleId, async () => {
    const state = await requireRoleState(roleId);
    if (state.current.id !== input.expectedCurrentVersionId) throw staleVersionConflict();
    if (state.definition.archivedAt !== undefined) return getPublicRole(roleId);
    const now = Date.now();
    await saveRoleDefinition(RoleDefinitionSchema.parse({
      ...state.definition,
      currentVersionId: state.current.id,
      archivedAt: now,
      updatedAt: now,
    }));
    return getPublicRole(roleId);
  });
}

export async function hardDeletePublicRole(
  roleId: string,
  value: unknown,
): Promise<void> {
  const input = RoleLifecycleInputSchema.parse(value) as RoleLifecycleInput & {
    action: 'archive' | 'delete';
  };
  if (input.action !== 'delete') {
    throw new RoleAdminConflictError('Hard deletion requires action "delete".');
  }
  assertMutableRole(roleId);
  return roleLock(roleId, async () => {
    const state = await readRoleState(roleId);
    if (!state) return;
    if (state.current.id !== input.expectedCurrentVersionId) throw staleVersionConflict();
    const versionIds = new Set(state.versions.map((version) => version.id));
    const referencingPersonas = (await listPersonasStrict()).filter(
      (persona) => versionIds.has(persona.roleVersionId),
    );
    if (referencingPersonas.length > 0) {
      throw new RoleAdminConflictError(
        `Role is pinned by ${referencingPersonas.length} Persona(s); archive it instead.`,
        {
          reason: 'PERSONA_REFERENCES',
          personaCount: referencingPersonas.length,
          personaIds: referencingPersonas.map((persona) => persona.id).sort(),
        },
      );
    }
    for (const version of state.versions) {
      await deleteRoleVersionRecord(version.id);
    }
    await deleteRoleDefinitionRecord(roleId);
  });
}

export async function applyRoleLifecycle(
  roleId: string,
  value: unknown,
): Promise<PublicRole | null> {
  const input = RoleLifecycleInputSchema.parse(value) as RoleLifecycleInput & {
    action: 'archive' | 'delete';
  };
  if (input.action === 'delete') {
    await hardDeletePublicRole(roleId, input);
    return null;
  }
  return archivePublicRole(roleId, input);
}
