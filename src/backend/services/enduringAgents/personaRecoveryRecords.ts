import { PersonaRecoveryError } from './personaRecoveryError';
import type { ZodType } from 'zod';
import {
  BehaviorBindingSchema, BehaviorMaintenanceRunSchema, BehaviorOutcomeMetricSchema,
  BehaviorProposalSchema, BehaviorRevisionSchema, MemoryItemSchema, PersonaActivitySchema,
  PersonaAppGrantSchema, PersonaCreationDraftSchema, PersonaDeletionTombstoneSchema,
  PersonaLeaseSchema, PersonaMailboxItemSchema, PersonaSchema, PersonaWorkItemSchema,
  RoleDefinitionSchema, RoleVersionSchema, type BehaviorRevision,
} from '@/shared/types/enduringAgent';
import { assertValidWorkspaceName } from '@/utils/workspace';
import { ENDURING_AGENT_COLLECTIONS as collections } from './collections';
import { BEHAVIOR_CALL_PINS_COLLECTION, BehaviorCallPinSchema } from './behaviorCallPins';
import { PersonaFlowDispatchRecordSchema } from './personaFlowDispatchSchema';
import { PersonaRuntimeRecoveryReceiptSchema } from './activityRuntime';
import { assertBehaviorRevisionIntegrity } from './store';
import {
  enduringAgentRecordMigrations, enduringAgentRecordSchemaVersion, migrateAndParseRecord,
} from './recordMigrations';

export interface PersonaRecoveryRecordSpec {
  kind: string;
  schema: ZodType;
  /** These records are preserved as evidence, never installed as live authority. */
  evidenceOnly?: true;
}

/** The complete fixed inventory; an unknown category cannot become a restore path. */
export const PERSONA_RECOVERY_RECORD_SPECS = Object.freeze({
  [collections.roleDefinitions]: { kind: 'RoleDefinition', schema: RoleDefinitionSchema },
  [collections.roleVersions]: { kind: 'RoleVersion', schema: RoleVersionSchema },
  [collections.personas]: { kind: 'Persona', schema: PersonaSchema },
  [collections.personaCreationDrafts]: { kind: 'PersonaCreationDraft', schema: PersonaCreationDraftSchema },
  [collections.behaviorBindings]: { kind: 'BehaviorBinding', schema: BehaviorBindingSchema },
  [collections.behaviorRevisions]: { kind: 'BehaviorRevision', schema: BehaviorRevisionSchema },
  [collections.behaviorProposals]: { kind: 'BehaviorProposal', schema: BehaviorProposalSchema },
  [collections.behaviorMaintenanceRuns]: { kind: 'BehaviorMaintenanceRun', schema: BehaviorMaintenanceRunSchema },
  [collections.behaviorOutcomeMetrics]: { kind: 'BehaviorOutcomeMetric', schema: BehaviorOutcomeMetricSchema },
  [collections.appGrants]: { kind: 'PersonaAppGrant', schema: PersonaAppGrantSchema, evidenceOnly: true },
  [collections.activities]: { kind: 'PersonaActivity', schema: PersonaActivitySchema },
  [collections.workItems]: { kind: 'PersonaWorkItem', schema: PersonaWorkItemSchema },
  [collections.memoryItems]: { kind: 'MemoryItem', schema: MemoryItemSchema },
  [collections.mailboxItems]: { kind: 'PersonaMailboxItem', schema: PersonaMailboxItemSchema, evidenceOnly: true },
  [collections.flowDispatches]: { kind: 'PersonaFlowDispatch', schema: PersonaFlowDispatchRecordSchema, evidenceOnly: true },
  [collections.runtimeRecoveryReceipts]: { kind: 'PersonaRuntimeRecoveryReceipt', schema: PersonaRuntimeRecoveryReceiptSchema, evidenceOnly: true },
  [collections.leaseHistory]: { kind: 'PersonaLease', schema: PersonaLeaseSchema, evidenceOnly: true },
  [collections.leases]: { kind: 'PersonaLease', schema: PersonaLeaseSchema, evidenceOnly: true },
  [collections.deletionTombstones]: { kind: 'PersonaDeletionTombstone', schema: PersonaDeletionTombstoneSchema },
  [BEHAVIOR_CALL_PINS_COLLECTION]: { kind: 'BehaviorCallPin', schema: BehaviorCallPinSchema, evidenceOnly: true },
} satisfies Record<string, PersonaRecoveryRecordSpec>);

export type PersonaRecoveryCollection = keyof typeof PERSONA_RECOVERY_RECORD_SPECS;
export interface ValidatedPersonaRecoveryRecord {
  collection: PersonaRecoveryCollection;
  id: string;
  original: Record<string, unknown>;
  parsed: Record<string, unknown>;
  migrated: boolean;
  evidenceOnly: boolean;
}

/**
 * Validate supported migrations without replacing historical source bytes. The
 * parsed view is for graph checks and an explicit restore plan; archive writers
 * must retain the original file buffer, including legacy immutable Flow fields.
 * This validates one record, not the cross-record graph or archive as a whole.
 */
export function validatePersonaRecoveryRecord(
  collection: string,
  value: unknown,
  sourceWorkspace: string,
): ValidatedPersonaRecoveryRecord {
  assertValidWorkspaceName(sourceWorkspace);
  if (!Object.prototype.hasOwnProperty.call(PERSONA_RECOVERY_RECORD_SPECS, collection)) {
    throw new PersonaRecoveryError(`Unsupported Persona recovery collection: ${collection}`);
  }
  const spec: PersonaRecoveryRecordSpec = PERSONA_RECOVERY_RECORD_SPECS[collection as PersonaRecoveryCollection];
  const parsed = migrateAndParseRecord({
    recordKind: spec.kind,
    value,
    currentVersion: enduringAgentRecordSchemaVersion(spec.kind),
    migrations: enduringAgentRecordMigrations(spec.kind),
    schema: spec.schema,
  }) as Record<string, unknown>;
  if (typeof parsed.id !== 'string') throw new PersonaRecoveryError('A recovery record must have an id.');
  if ('workspaceId' in parsed && parsed.workspaceId !== sourceWorkspace) {
    throw new PersonaRecoveryError(`${spec.kind} ${parsed.id} belongs to another workspace.`);
  }
  if (spec.kind === 'BehaviorRevision') {
    assertBehaviorRevisionIntegrity(parsed as unknown as BehaviorRevision, value);
  }
  const original = value as Record<string, unknown>;
  return {
    collection: collection as PersonaRecoveryCollection,
    id: parsed.id,
    original,
    parsed,
    migrated: original.schemaVersion !== parsed.schemaVersion,
    evidenceOnly: spec.evidenceOnly === true,
  };
}
