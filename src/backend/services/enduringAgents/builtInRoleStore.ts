import {
  RoleDefinitionSchema,
  type RoleDefinition,
  type RoleVersion,
} from '@/shared/types/enduringAgent';

import {
  BUILT_IN_DEVELOPER_ROLE_ID,
  buildBuiltInDeveloperRoleDefinition,
  buildBuiltInDeveloperRoleVersion,
} from './builtInDeveloperRole';
import {
  createRoleVersion,
  getRoleDefinition,
  saveRoleDefinition,
} from './store';

export interface BuiltInDeveloperRole {
  roleDefinition: RoleDefinition;
  roleVersion: RoleVersion;
}

/**
 * Idempotently seed Developer v1 in the selected workspace. The RoleVersion
 * store is immutable, so a conflicting record fails instead of silently
 * repinning or rewriting existing Personas.
 */
export async function ensureBuiltInDeveloperRole(): Promise<BuiltInDeveloperRole> {
  const builtInDefinition = buildBuiltInDeveloperRoleDefinition();
  const existingDefinition = await getRoleDefinition(BUILT_IN_DEVELOPER_ROLE_ID);
  const roleDefinition = existingDefinition
    ?? await saveRoleDefinition(builtInDefinition);
  const roleVersion = await createRoleVersion(buildBuiltInDeveloperRoleVersion());

  if (roleDefinition.currentVersionId === roleVersion.id) {
    return { roleDefinition, roleVersion };
  }

  const repairedDefinition = RoleDefinitionSchema.parse({
    ...roleDefinition,
    currentVersionId: roleVersion.id,
    updatedAt: Math.max(Date.now(), roleDefinition.updatedAt + 1),
  });

  return {
    roleDefinition: await saveRoleDefinition(repairedDefinition),
    roleVersion,
  };
}
