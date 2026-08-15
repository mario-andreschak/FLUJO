import {
  createPersonaFromRole as createPersonaFromRoleProduction,
} from '@/backend/services/enduringAgents';
import { buildDefaultRoleBehaviorSlots } from '@/backend/services/enduringAgents/roleBehaviorDefaults';
import {
  createRoleVersion,
  getRoleDefinition,
  saveRoleDefinition,
} from '@/backend/services/enduringAgents/store';
import {
  ROLE_DEFINITION_SCHEMA_VERSION,
  ROLE_VERSION_SCHEMA_VERSION,
  RoleDefinitionSchema,
  RoleVersionSchema,
  type RoleDefinition,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';
import { StorageKey } from '@/shared/types/storage';
import { saveItem } from '@/utils/storage/backend';

export const TEST_ROLE_ID = 'role_test_general';
export const TEST_ROLE_VERSION_ID = 'rolever_test_general_v1';

function testCoreFlow(): Flow {
  return {
    id: 'test_general_core',
    name: 'Test general Core',
    permissionRules: [],
    nodes: [
      {
        id: 'test_core_start',
        type: 'start',
        position: { x: 0, y: 0 },
        data: { label: 'Start', type: 'start', properties: { promptTemplate: 'Start.' } },
      },
      {
        id: 'test_core_process',
        type: 'process',
        position: { x: 280, y: 0 },
        data: {
          label: 'Coordinate',
          type: 'process',
          properties: { promptTemplate: 'Complete the explicitly assigned task.' },
        },
      },
      {
        id: 'test_core_finish',
        type: 'finish',
        position: { x: 560, y: 0 },
        data: { label: 'Finish', type: 'finish' },
      },
    ],
    edges: [
      { id: 'test_core_start_process', source: 'test_core_start', target: 'test_core_process' },
      { id: 'test_core_process_finish', source: 'test_core_process', target: 'test_core_finish' },
    ],
  };
}

export function buildTestRoleDefinition(): RoleDefinition {
  return RoleDefinitionSchema.parse({
    schemaVersion: ROLE_DEFINITION_SCHEMA_VERSION,
    id: TEST_ROLE_ID,
    name: 'Test general Role',
    description: 'Workspace-authored test fixture with no production seeding semantics.',
    currentVersionId: TEST_ROLE_VERSION_ID,
    createdAt: 1,
    updatedAt: 1,
  });
}

export function buildTestRoleVersion(): RoleVersion {
  return RoleVersionSchema.parse({
    schemaVersion: ROLE_VERSION_SCHEMA_VERSION,
    id: TEST_ROLE_VERSION_ID,
    roleDefinitionId: TEST_ROLE_ID,
    version: 1,
    name: 'Test general Role v1',
    mission: 'Exercise generalized Persona behavior without a predefined product Role.',
    coreFlowTemplate: testCoreFlow(),
    behaviorSlots: buildDefaultRoleBehaviorSlots(TEST_ROLE_ID, 'Test general Role'),
    defaults: {
      autonomyLevel: 'propose_overrides',
      interruptionPolicy: 'queue',
      memory: { candidateLimitPerActivity: 3, coreMemoryMaxItems: 32 },
    },
    createdAt: 1,
  });
}

export async function ensureTestRole(): Promise<{
  roleDefinition: RoleDefinition;
  roleVersion: RoleVersion;
}> {
  const roleDefinition = await getRoleDefinition(TEST_ROLE_ID)
    ?? await saveRoleDefinition(buildTestRoleDefinition());
  const roleVersion = await createRoleVersion(buildTestRoleVersion());
  return { roleDefinition, roleVersion };
}

export async function createPersonaFromRole(
  value: unknown,
): Promise<Awaited<ReturnType<typeof createPersonaFromRoleProduction>>> {
  await saveItem(StorageKey.MODELS, [{
    id: 'model-test',
    name: 'test-model',
    displayName: 'Test model',
    provider: 'openai',
  }]);
  await ensureTestRole();
  const input = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return createPersonaFromRoleProduction({
    ...input,
    roleVersionId: input.roleVersionId ?? TEST_ROLE_VERSION_ID,
  });
}
