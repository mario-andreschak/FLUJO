import { createHash } from 'crypto';

export const PERSONA_RUNTIME_RETENTION_COHORT_VERSION =
  'persona-runtime-retention-v1';
export const PERSONA_RUNTIME_RETENTION_BUCKET_COUNT = 10_000;

export interface PersonaRetentionCohortInput {
  workspaceId: string;
  personaId: string;
  cohortVersion?: string;
}

export interface PersonaRetentionCohort {
  version: string;
  bucket: number;
}

function framed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * Return a stable, versioned workspace/Persona bucket in [0, 9999].
 */
export function getPersonaRetentionCohort(
  input: PersonaRetentionCohortInput,
): PersonaRetentionCohort {
  const version = input.cohortVersion
    ?? PERSONA_RUNTIME_RETENTION_COHORT_VERSION;
  const digest = createHash('sha256')
    .update([
      framed(version),
      framed(input.workspaceId),
      framed(input.personaId),
    ].join('|'))
    .digest();
  return {
    version,
    bucket: digest.readUInt32BE(0) % PERSONA_RUNTIME_RETENTION_BUCKET_COUNT,
  };
}

export function isPersonaInRetentionCohort(
  cohort: PersonaRetentionCohort,
  rolloutBasisPoints: number,
): boolean {
  if (
    !Number.isSafeInteger(rolloutBasisPoints)
    || rolloutBasisPoints < 0
    || rolloutBasisPoints > PERSONA_RUNTIME_RETENTION_BUCKET_COUNT
  ) {
    throw new Error('rolloutBasisPoints must be an integer from 0 through 10000.');
  }
  return cohort.bucket < rolloutBasisPoints;
}

export type PersonaRetentionEligibilityReason =
  | 'selected'
  | 'critical'
  | 'outside-cohort'
  | 'disabled'
  | 'invalid';

export interface PersonaRetentionEligibility {
  eligible: boolean;
  reason: PersonaRetentionEligibilityReason;
  cohort: PersonaRetentionCohort;
}

export function getPersonaRetentionEligibility(input: {
  workspaceId: string;
  personaId: string;
  cohortVersion: string;
  rolloutBasisPoints: number;
  criticalPersonaIds: readonly string[];
}): PersonaRetentionEligibility {
  const cohort = getPersonaRetentionCohort(input);
  if (input.criticalPersonaIds.includes(input.personaId)) {
    return { eligible: false, reason: 'critical', cohort };
  }
  if (!isPersonaInRetentionCohort(cohort, input.rolloutBasisPoints)) {
    return { eligible: false, reason: 'outside-cohort', cohort };
  }
  return { eligible: true, reason: 'selected', cohort };
}
