import type { RoleDefinition, RoleVersion } from '@/shared/types/enduringAgent';

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
  const roleDefinition = await getRoleDefinition(BUILT_IN_DEVELOPER_ROLE_ID)
    ?? await saveRoleDefinition(builtInDefinition);
  const roleVersion = await createRoleVersion(buildBuiltInDeveloperRoleVersion());
  return { roleDefinition, roleVersion };
}
