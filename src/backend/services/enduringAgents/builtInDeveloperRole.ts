import type { Flow } from '@/shared/types/flow';
import {
  ROLE_DEFINITION_SCHEMA_VERSION,
  ROLE_VERSION_SCHEMA_VERSION,
  RoleDefinitionSchema,
  RoleVersionSchema,
  type RoleDefinition,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import { buildMaintainMemoryRoleBehaviorSlot } from './roleBehaviorDefaults';

export const BUILT_IN_DEVELOPER_ROLE_ID = 'role_builtin_developer';
export const BUILT_IN_DEVELOPER_ROLE_VERSION_ID = 'rolever_builtin_developer_v2';
export const BUILT_IN_DEVELOPER_ROLE_VERSION = 2;

const BUILT_IN_DEVELOPER_CREATED_AT = 1_786_233_600_000;

const CORE_FLOW_ID = 'builtin_developer_core_v1';
const PRIMARY_FLOW_ID = 'builtin_developer_primary_v1';

const PRIMARY_START_PROMPT = `You are running the primary behavior for an enduring Developer persona.
Treat the latest user request as the task and use only the identity, context, and capabilities explicitly supplied for this Activity. Do not assume access to tools, accounts, memories, or facts that are not present.`;

const PRIMARY_PROCESS_PROMPT = `Act as a careful, practical software developer.
Inspect the relevant context before making changes, preserve unrelated work, and implement the smallest coherent solution that satisfies the request. Validate the result in proportion to its risk and report the outcome and any remaining uncertainty clearly. If a required capability is unavailable, explain the blocker instead of inventing a result.`;

function buildPrimaryFlowTemplate(): Flow {
  return {
    id: PRIMARY_FLOW_ID,
    name: 'Developer primary',
    description: 'General software-development behavior for an enduring Developer persona.',
    permissionRules: [],
    nodes: [
      {
        id: 'developer_primary_start',
        type: 'start',
        position: { x: 0, y: 0 },
        data: {
          label: 'Start',
          type: 'start',
          properties: { promptTemplate: PRIMARY_START_PROMPT },
        },
      },
      {
        id: 'developer_primary_process',
        type: 'process',
        position: { x: 280, y: 0 },
        data: {
          label: 'Develop',
          type: 'process',
          description: 'Understands, implements, and validates the requested software change.',
          properties: { promptTemplate: PRIMARY_PROCESS_PROMPT },
        },
      },
      {
        id: 'developer_primary_finish',
        type: 'finish',
        position: { x: 560, y: 0 },
        data: {
          label: 'Finish',
          type: 'finish',
        },
      },
    ],
    edges: [
      {
        id: 'developer_primary_start_process',
        source: 'developer_primary_start',
        target: 'developer_primary_process',
        sourceHandle: 'start-bottom',
        targetHandle: 'process-top',
      },
      {
        id: 'developer_primary_process_finish',
        source: 'developer_primary_process',
        target: 'developer_primary_finish',
        sourceHandle: 'process-bottom',
        targetHandle: 'finish-top',
      },
    ],
  };
}

function buildCoreFlowTemplate(): Flow {
  return {
    id: CORE_FLOW_ID,
    name: 'Developer core',
    description: 'Core orchestration flow for an enduring Developer persona.',
    permissionRules: [],
    nodes: [
      {
        id: 'developer_core_start',
        type: 'start',
        position: { x: 0, y: 0 },
        data: {
          label: 'Start',
          type: 'start',
          properties: {
            promptTemplate: 'Coordinate the selected enduring Persona behavior for this Activity.',
          },
        },
      },
      {
        id: 'developer_core_process',
        type: 'process',
        position: { x: 280, y: 0 },
        data: {
          label: 'Coordinate behavior',
          type: 'process',
          properties: {
            promptTemplate: 'Run the selected required behavior and produce the requested result.',
          },
        },
      },
      {
        id: 'developer_core_finish',
        type: 'finish',
        position: { x: 560, y: 0 },
        data: { label: 'Finish', type: 'finish' },
      },
    ],
    edges: [
      {
        id: 'developer_core_start_process',
        source: 'developer_core_start',
        target: 'developer_core_process',
        sourceHandle: 'start-bottom',
        targetHandle: 'process-top',
      },
      {
        id: 'developer_core_process_finish',
        source: 'developer_core_process',
        target: 'developer_core_finish',
        sourceHandle: 'process-bottom',
        targetHandle: 'finish-top',
      },
    ],
  };
}

/** Build the stable workspace-owned Developer Role family record. */
export function buildBuiltInDeveloperRoleDefinition(): RoleDefinition {
  return RoleDefinitionSchema.parse({
    schemaVersion: ROLE_DEFINITION_SCHEMA_VERSION,
    id: BUILT_IN_DEVELOPER_ROLE_ID,
    name: 'Developer',
    description: 'A reusable role for understanding, implementing, and validating software changes.',
    currentVersionId: BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
    createdAt: BUILT_IN_DEVELOPER_CREATED_AT,
    updatedAt: BUILT_IN_DEVELOPER_CREATED_AT,
  });
}

/** Build the immutable current Developer version without reading or writing ambient state. */
export function buildBuiltInDeveloperRoleVersion(): RoleVersion {
  const maintainMemory = buildMaintainMemoryRoleBehaviorSlot(
    BUILT_IN_DEVELOPER_ROLE_ID,
    'Developer',
    {
      flowId: 'builtin_developer_maintain_memory_v1',
      flowName: 'Developer memory maintenance',
      nodePrefix: 'developer_memory',
    },
  );
  return RoleVersionSchema.parse({
    schemaVersion: ROLE_VERSION_SCHEMA_VERSION,
    id: BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
    roleDefinitionId: BUILT_IN_DEVELOPER_ROLE_ID,
    version: BUILT_IN_DEVELOPER_ROLE_VERSION,
    name: 'Developer v2',
    mission: 'Deliver reliable software changes while preserving user intent, existing work, and system safety.',
    coreFlowTemplate: buildCoreFlowTemplate(),
    behaviorSlots: [
      {
        key: 'primary',
        name: 'Primary development',
        description: 'Understand, implement, validate, and clearly report general software work.',
        requiredCapabilities: [
          'filesystem.workspace',
          'source-control.read-write',
          'shell.compile-test',
          'structured-data.json',
        ],
        flowTemplate: buildPrimaryFlowTemplate(),
      },
      {
        ...maintainMemory,
      },
    ],
    capabilityRequirements: {
      semantic: [
        'filesystem.workspace',
        'source-control.read-write',
        'shell.compile-test',
        'structured-data.json',
      ],
    },
    defaults: {
      autonomyLevel: 'propose_overrides',
      interruptionPolicy: 'queue',
      memory: {
        candidateLimitPerActivity: 3,
        coreMemoryMaxItems: 32,
      },
    },
    migrationNotes: 'Adds a Persona-owned Core template and explicit runnable-model resolution.',
    createdAt: BUILT_IN_DEVELOPER_CREATED_AT,
  });
}
