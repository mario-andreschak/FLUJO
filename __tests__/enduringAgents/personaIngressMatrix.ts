export type PersonaIngressAdmission =
  | 'dispatcher'
  | 'runtime-route'
  | 'steering'
  | 'scheduler'
  | 'meeting-reservation';

export interface PersonaIngressExpectation {
  label: string;
  mailboxKind: 'interactive_chat' | 'assignment' | 'scheduled' | 'triggered' | 'meeting' | 'voice';
  sourceKind: 'chat' | 'assignment' | 'schedule' | 'trigger' | 'meeting' | 'voice';
  admission: PersonaIngressAdmission;
  contention: 'acquire-or-queue' | 'steer-active' | 'coalesce-or-conflict' | 'reserve-all-or-none';
  restartSource: 'dispatcher' | 'steering-payload' | 'scheduler-projection' | 'lease-recovery';
  supportsSteering: boolean;
}

export const PERSONA_INGRESS_MATRIX = [
  {
    label: 'core chat',
    mailboxKind: 'interactive_chat',
    sourceKind: 'chat',
    admission: 'dispatcher',
    contention: 'acquire-or-queue',
    restartSource: 'dispatcher',
    supportsSteering: false,
  },
  {
    label: 'related chat injection',
    mailboxKind: 'interactive_chat',
    sourceKind: 'chat',
    admission: 'steering',
    contention: 'steer-active',
    restartSource: 'steering-payload',
    supportsSteering: true,
  },
  {
    label: 'explicit assignment',
    mailboxKind: 'assignment',
    sourceKind: 'assignment',
    admission: 'runtime-route',
    contention: 'acquire-or-queue',
    restartSource: 'dispatcher',
    supportsSteering: false,
  },
  {
    label: 'schedule',
    mailboxKind: 'scheduled',
    sourceKind: 'schedule',
    admission: 'scheduler',
    contention: 'coalesce-or-conflict',
    restartSource: 'scheduler-projection',
    supportsSteering: false,
  },
  {
    label: 'trigger',
    mailboxKind: 'triggered',
    sourceKind: 'trigger',
    admission: 'scheduler',
    contention: 'coalesce-or-conflict',
    restartSource: 'scheduler-projection',
    supportsSteering: false,
  },
  {
    label: 'meeting',
    mailboxKind: 'meeting',
    sourceKind: 'meeting',
    admission: 'meeting-reservation',
    contention: 'reserve-all-or-none',
    restartSource: 'lease-recovery',
    supportsSteering: false,
  },
  {
    label: 'transcript voice',
    mailboxKind: 'voice',
    sourceKind: 'voice',
    admission: 'dispatcher',
    contention: 'steer-active',
    restartSource: 'dispatcher',
    supportsSteering: true,
  },
] as const satisfies readonly PersonaIngressExpectation[];

export interface PersonaContinuitySnapshot {
  personaId: string;
  activityId: string;
  fencingToken: number;
  behaviorRevisionId: string;
  roleVersionId: string;
  relationId: string;
  sourceKind: PersonaIngressExpectation['sourceKind'];
  sourceId: string;
  dispatchId?: string;
}

/**
 * Asserts the immutable identity which every Persona ingress must preserve.
 * A recovered lease must advance its fence while all attribution stays pinned.
 */
export function expectPersonaContinuity(
  before: PersonaContinuitySnapshot,
  after: PersonaContinuitySnapshot,
): void {
  expect(after).toMatchObject({
    personaId: before.personaId,
    activityId: before.activityId,
    behaviorRevisionId: before.behaviorRevisionId,
    roleVersionId: before.roleVersionId,
    relationId: before.relationId,
    sourceKind: before.sourceKind,
    sourceId: before.sourceId,
  });
  if (before.dispatchId !== undefined) {
    expect(after.dispatchId).toBe(before.dispatchId);
  }
  expect(after.fencingToken).toBeGreaterThanOrEqual(before.fencingToken);
}

export const PERSONA_AUTHORITY_NEGATIVE_CONTROLS = [
  'persona-less-flow',
  'ordinary-subflow',
] as const;
