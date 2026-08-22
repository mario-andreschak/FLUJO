/**
 * Product-facing Persona capabilities.
 *
 * This is deliberately written in ordinary language. Runtime primitives may
 * implement a capability, but a capability is only considered shipped when it
 * has a discoverable UI location and a recovery/undo story here.
 */
export const PERSONA_NATIVE_ABILITY_IDS = [
  'remember',
  'recall',
  'resolve_conflict',
  'correct',
  'forget',
  'pin',
  'unpin',
  'work_item_create',
  'work_item_update',
  'work_item_complete',
  'work_item_promote_todo',
  'suggest_improvement',
] as const;

export type PersonaNativeAbilityId = (typeof PERSONA_NATIVE_ABILITY_IDS)[number];

/** Safe defaults for newly materialized Persona Core Flows. */
export const DEFAULT_PERSONA_NATIVE_ABILITY_IDS = PERSONA_NATIVE_ABILITY_IDS.filter(
  (ability): ability is Exclude<PersonaNativeAbilityId, 'forget' | 'resolve_conflict'> => (
    ability !== 'forget' && ability !== 'resolve_conflict'
  ),
);

export const PERSONA_CAPABILITY_AREAS = [
  'overview',
  'setup',
  'memory',
  'tasks',
  'improvements',
  'automations',
  'settings',
] as const;

export type PersonaCapabilityArea = (typeof PERSONA_CAPABILITY_AREAS)[number];

export interface PersonaCapabilityDefinition {
  id: string;
  name: string;
  description: string;
  backendOperations: readonly string[];
  /** Public product endpoints exercised by this capability. */
  backendEndpoints: readonly string[];
  ui: {
    area: PersonaCapabilityArea;
    label: string;
    /** Concrete, discoverable UI owners. Kept here so parity is testable. */
    entryPoints: readonly string[];
  };
  availability: 'always' | 'configurable' | 'when-needed';
  recovery: string;
}

/**
 * One source of truth for user-operable Persona backend behavior. New shipped
 * operations belong in an existing entry or require a new UI-backed entry.
 */
export const PERSONA_CAPABILITY_MANIFEST = [
  {
    id: 'persona-lifecycle',
    name: 'Create and manage a Persona',
    description: 'Start from a Role, resume unfinished setup, change the Persona, or remove it.',
    backendOperations: [
      'personas.list',
      'personas.read',
      'personas.create',
      'personas.update',
      'personas.summarize',
      'personas.setup-options',
      'drafts.list',
      'drafts.read',
      'drafts.create',
      'drafts.update',
      'drafts.delete',
    ],
    backendEndpoints: [
      'GET /v1/personas',
      'POST /v1/personas',
      'GET /v1/personas/summary',
      'GET /v1/personas/settings-options',
      'GET /v1/personas/[personaId]',
      'PATCH /v1/personas/[personaId]',
      'GET /v1/persona-drafts',
      'POST /v1/persona-drafts',
      'GET /v1/persona-drafts/[draftId]',
      'PATCH /v1/persona-drafts/[draftId]',
      'DELETE /v1/persona-drafts/[draftId]',
    ],
    ui: {
      area: 'setup',
      label: 'Create or manage a Persona',
      entryPoints: [
        'src/frontend/components/Personas/PersonasGallery.tsx',
        'src/frontend/components/Personas/PersonaCreationWizard.tsx',
        'src/frontend/components/Personas/settings/PersonaSettings.tsx',
      ],
    },
    availability: 'always',
    recovery: 'Resume an unfinished Persona from the gallery or remove its saved draft.',
  },
  {
    id: 'goals-and-work',
    name: 'Take responsibility for goals',
    description: 'Accept a goal, keep it queued across restarts, and show when it is working, blocked, or done.',
    backendOperations: [
      'work-items.create',
      'work-items.assign',
      'work-items.update',
      'work-items.delete',
      'work-items.promote-todo',
      'work-items.pause',
      'work-items.stop',
      'work-items.retry',
      'work-items.move-earlier',
      'work-items.move-later',
      'activities.dispatch',
    ],
    backendEndpoints: [
      'GET /v1/personas/[personaId]/work-items',
      'POST /v1/personas/[personaId]/work-items',
      'GET /v1/personas/[personaId]/work-items/[workItemId]',
      'PATCH /v1/personas/[personaId]/work-items/[workItemId]',
      'DELETE /v1/personas/[personaId]/work-items/[workItemId]',
      'POST /v1/personas/[personaId]/work-items/[workItemId]/assign',
      'POST /v1/personas/[personaId]/work-items/[workItemId]/control',
      'POST /v1/personas/[personaId]/work-items/promote-todo',
    ],
    ui: {
      area: 'overview',
      label: 'Give this Persona a goal',
      entryPoints: ['src/frontend/components/Personas/index.tsx'],
    },
    availability: 'always',
    recovery: 'Edit, cancel, retry, or remove the goal from Tasks.',
  },
  {
    id: 'memory',
    name: 'Remember useful context',
    description: 'Remember, find, correct, review, prioritize, and forget information with a visible source.',
    backendOperations: [
      'memory.remember',
      'memory.recall',
      'memory.resolve-conflict',
      'memory.correct',
      'memory.forget',
      'memory.pin',
      'memory.unpin',
      'memory.review',
    ],
    backendEndpoints: [
      'GET /v1/personas/[personaId]/memories',
      'POST /v1/personas/[personaId]/memories',
      'GET /v1/personas/[personaId]/memories/[memoryId]',
      'DELETE /v1/personas/[personaId]/memories/[memoryId]',
      'POST /v1/personas/[personaId]/memories/[memoryId]/resolve-conflict',
      'POST /v1/personas/[personaId]/memories/[memoryId]/activate',
      'POST /v1/personas/[personaId]/memories/[memoryId]/correct',
      'POST /v1/personas/[personaId]/memories/[memoryId]/pin',
      'DELETE /v1/personas/[personaId]/memories/[memoryId]/pin',
    ],
    ui: {
      area: 'memory',
      label: 'Memory',
      entryPoints: ['src/frontend/components/Personas/PersonaMemoryArea.tsx'],
    },
    availability: 'configurable',
    recovery: 'Correct or forget a memory; earlier versions remain in its history.',
  },
  {
    id: 'effective-abilities',
    name: 'Understand and choose abilities',
    description: 'Show the Apps, specialist Behaviors, memory, and Task actions the Persona can really use.',
    backendOperations: [
      'abilities.preview',
      'abilities.configure',
    ],
    backendEndpoints: ['GET /v1/personas/[personaId]/execution-preview'],
    ui: {
      area: 'overview',
      label: 'What this Persona can do',
      entryPoints: [
        'src/frontend/components/Personas/index.tsx',
        'src/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PersonaAbilities.tsx',
      ],
    },
    availability: 'configurable',
    recovery: 'Turn individual abilities off in the Persona abilities section of its Flow.',
  },
  {
    id: 'behaviors',
    name: 'Use specialist Behaviors',
    description: 'Call the Persona\'s selected Behavior Flows while keeping their setup editable in Flow Builder.',
    backendOperations: [
      'behaviors.add',
      'behaviors.replace',
      'behaviors.activate',
      'behaviors.remove',
    ],
    backendEndpoints: [
      'GET /v1/personas/[personaId]/composition',
      'PATCH /v1/personas/[personaId]/composition',
      'POST /v1/personas/[personaId]/composition/copy',
      'POST /v1/personas/[personaId]/behaviors/[behaviorId]/activate',
    ],
    ui: {
      area: 'setup',
      label: 'Behaviors',
      entryPoints: ['src/frontend/components/Personas/PersonaFlowsArea.tsx'],
    },
    availability: 'configurable',
    recovery: 'Switch back to the shared Flow or choose the earlier Behavior Flow.',
  },
  {
    id: 'apps',
    name: 'Use selected Apps',
    description: 'Use only the App accounts selected for the Persona\'s main Flow.',
    backendOperations: [
      'apps.add',
      'apps.replace',
      'apps.remove',
      'apps.open',
    ],
    backendEndpoints: [
      'GET /v1/personas/[personaId]/app-grants',
      'POST /v1/personas/[personaId]/app-grants',
      'PATCH /v1/personas/[personaId]/app-grants/[grantId]',
      'DELETE /v1/personas/[personaId]/app-grants/[grantId]',
      'POST /v1/personas/[personaId]/app-grants/[grantId]/launch',
    ],
    ui: {
      area: 'setup',
      label: 'Apps',
      entryPoints: ['src/frontend/components/Personas/PersonaSetup.tsx'],
    },
    availability: 'configurable',
    recovery: 'Remove or switch an App account from Setup.',
  },
  {
    id: 'improvements',
    name: 'Improve with review and undo',
    description: 'Show evaluated Behavior suggestions, let the user apply them, and make every applied change reversible.',
    backendOperations: [
      'improvements.list',
      'improvements.propose',
      'improvements.approve',
      'improvements.activate',
      'improvements.reject',
      'improvements.rollback',
      'improvements.promote-to-role',
    ],
    backendEndpoints: [
      'GET /v1/personas/[personaId]/improvements',
      'POST /v1/personas/[personaId]/improvements/[proposalId]/apply',
      'POST /v1/personas/[personaId]/improvements/[proposalId]/reject',
      'POST /v1/personas/[personaId]/improvements/[proposalId]/undo',
      'POST /v1/personas/[personaId]/improvements/[proposalId]/promote',
    ],
    ui: {
      area: 'improvements',
      label: 'Improvements',
      entryPoints: ['src/frontend/components/Personas/PersonaImprovementsArea.tsx'],
    },
    availability: 'when-needed',
    recovery: 'Undo an applied improvement from Improvements.',
  },
  {
    id: 'conversations',
    name: 'Talk naturally',
    description: 'Chat with the Persona\'s main role or one specialist Behavior and keep the conversation as its shared record.',
    backendOperations: [
      'conversations.start',
      'conversations.send',
      'conversations.choose-behavior',
    ],
    backendEndpoints: [
      'POST /v1/chat/conversations',
      'POST /v1/chat/completions',
    ],
    ui: {
      area: 'overview',
      label: 'Chat',
      entryPoints: [
        'src/frontend/components/Personas/PersonaDetailShell.tsx',
        'src/frontend/components/Chat/ChatTargetSelector.tsx',
      ],
    },
    availability: 'always',
    recovery: 'Open the saved conversation again or start a new one from the Persona.',
  },
  {
    id: 'meetings',
    name: 'Join a meeting',
    description: 'Add a Persona with its main role or one specialist Behavior and keep that choice visible.',
    backendOperations: ['meetings.add-persona'],
    backendEndpoints: ['POST /v1/meetings'],
    ui: {
      area: 'overview',
      label: 'Meet',
      entryPoints: [
        'src/frontend/components/Personas/PersonaDetailShell.tsx',
        'src/frontend/components/Meetings/MeetingWizard.tsx',
      ],
    },
    availability: 'always',
    recovery: 'Remove the Persona before starting, or end the meeting from its controls.',
  },
  {
    id: 'automations',
    name: 'Work on a schedule or event',
    description: 'Run the Persona, or one selected Behavior, when a schedule or chosen event happens.',
    backendOperations: [
      'automations.create-persona-target',
      'automations.update-persona-target',
      'automations.clear-persona-target',
    ],
    backendEndpoints: [
      'POST /api/planned-executions',
      'PATCH /api/planned-executions/[id]',
    ],
    ui: {
      area: 'automations',
      label: 'Automations',
      entryPoints: ['src/frontend/components/PlannedExecutions/ExecutionModal.tsx'],
    },
    availability: 'configurable',
    recovery: 'Pause, edit, or delete the automation.',
  },
  {
    id: 'runtime-recovery',
    name: 'Recover interrupted work',
    description: 'Keep durable work safe and offer a friendly repair action if it cannot resume automatically.',
    backendOperations: ['runtime.inspect', 'runtime.recover'],
    backendEndpoints: [
      'POST /v1/personas/[personaId]/runtime-recovery',
      'GET /v1/personas/[personaId]/storage-stats',
    ],
    ui: {
      area: 'overview',
      label: 'Repair and continue',
      entryPoints: ['src/frontend/components/Personas/index.tsx'],
    },
    availability: 'when-needed',
    recovery: 'Run Repair and continue from the Persona home.',
  },
  {
    id: 'privacy-and-portability',
    name: 'Control Persona data',
    description: 'Review what an export or deletion will contain before making the change.',
    backendOperations: [
      'settings.update',
      'export.preview',
      'export.download',
      'deletion.preview',
      'deletion.confirm',
    ],
    backendEndpoints: [
      'POST /v1/personas/[personaId]/export-preview',
      'POST /v1/personas/[personaId]/export',
      'GET /v1/personas/[personaId]/deletion-preview',
      'DELETE /v1/personas/[personaId]',
    ],
    ui: {
      area: 'settings',
      label: 'Data',
      entryPoints: ['src/frontend/components/Personas/settings/PersonaSettings.tsx'],
    },
    availability: 'always',
    recovery: 'Exports are non-destructive; deletion requires a fresh preview and explicit confirmation.',
  },
] as const satisfies readonly PersonaCapabilityDefinition[];

export const PERSONA_UI_MAPPED_BACKEND_OPERATIONS = Object.freeze(
  PERSONA_CAPABILITY_MANIFEST.flatMap((capability) => capability.backendOperations),
);

export const PERSONA_UI_MAPPED_BACKEND_ENDPOINTS = Object.freeze(
  PERSONA_CAPABILITY_MANIFEST.flatMap((capability) => capability.backendEndpoints),
);
