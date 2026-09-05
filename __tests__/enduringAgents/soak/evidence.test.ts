import {
  PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION,
  SOAK_CRITERION_REGISTRY,
  createSoakCriterion,
  soakEnforcementFailures,
  stableJsonStringify,
  criterionRequired,
  SOAK_UNDEFINED_CONTRACT_IDS,
  validateSoakCriterion,
  validateSoakEvidence,
  type SoakCriterionId,
  type SoakCriterionStatus,
  type SoakEvidenceDocument,
  type SoakRunIdentity,
} from './evidence';

function identity(): SoakRunIdentity {
  return {
    schemaVersion: PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION,
    runId: 'evidence-unit-test',
    mode: 'smoke',
    authoritative: false,
    commitSha: 'unreported',
    seed: 459,
    days: 3,
    activitiesPerDay: 5,
    learningEnabled: false,
    startedAt: '2026-08-22T00:00:00.000Z',
    endedAt: '2026-08-22T00:01:00.000Z',
    runner: {
      node: 'v22.0.0',
      platform: 'test',
      architecture: 'test',
      osRelease: 'test',
      cpuModel: 'test',
      logicalCpuCount: 1,
    },
    configuration: {
      gatingMode: 'enforce',
      recallSamplesPerDay: 5,
      eventAppendSamplesPerDay: 5,
      percentileMethod: 'nearest-rank',
      scheduledFaultIds: [],
    },
  };
}

function criterion(id: SoakCriterionId, status: SoakCriterionStatus = 'passed') {
  return createSoakCriterion({
    id,
    mode: 'smoke',
    status,
    summary: `${id} ${status}`,
    observed: { value: 1 },
    threshold: {
      description: 'deterministic test invariant',
      source: 'evidence unit test',
    },
    provenance: { sources: ['fixture'] },
    ...(status === 'passed' ? {} : { failureReason: `${status} by fixture` }),
  });
}

function document(): SoakEvidenceDocument {
  return {
    schemaVersion: PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION,
    runIdentity: identity(),
    workloadReconciliation: {
      attempted: 0,
      accepted: 0,
      completed: 0,
      failed: 0,
      duplicate: 0,
      unresolved: 0,
      missingSourceIds: [],
      duplicateSourceIds: [],
      nonterminalSourceIds: [],
      mailboxLinkMismatchSourceIds: [],
      identityMismatchSourceIds: [],
    },
    faultEvidence: [],
    criteria: (Object.keys(SOAK_CRITERION_REGISTRY) as SoakCriterionId[])
      .map(id => criterion(id)),
  };
}

describe('Persona soak evidence schema', () => {
  it('separates a passing infrastructure gate from unresolved release contracts without hiding them', () => {
    const evidence = document();
    evidence.runIdentity = { ...identity(), mode: 'infrastructure', days: 28, activitiesPerDay: 20, learningEnabled: true };
    evidence.criteria = evidence.criteria.map(record => ({
      ...record,
      required: criterionRequired(record.id, 'infrastructure'),
      ...(SOAK_UNDEFINED_CONTRACT_IDS.includes(record.id) ? { status: 'not_evaluated' as const, failureReason: 'Numeric release contract remains unresolved.' } : {}),
    }));
    expect(soakEnforcementFailures(evidence)).toEqual([]);
    expect(evidence.criteria.filter(record => record.status === 'not_evaluated')).toHaveLength(3);
    evidence.runIdentity = { ...evidence.runIdentity, mode: 'acceptance', authoritative: true, commitSha: 'a'.repeat(40) };
    evidence.criteria = evidence.criteria.map(record => ({ ...record, required: true }));
    expect(soakEnforcementFailures(evidence).filter(message => message.includes('required criterion'))).toHaveLength(3);
  });

  it('requires full workload and denies authoritative status to infrastructure reports', () => {
    const evidence = document();
    evidence.runIdentity = { ...identity(), mode: 'infrastructure', authoritative: true };
    expect(validateSoakEvidence(evidence)).toEqual(expect.arrayContaining([
      expect.stringContaining('only acceptance'), expect.stringContaining('full 28x20'),
    ]));
  });

  it.each(['passed', 'failed', 'not_evaluated'] as const)(
    'serializes and validates the %s criterion state',
    (status) => {
      const record = criterion('unattended-runtime-throughput', status);
      expect(validateSoakCriterion(record, 'smoke')).toEqual([]);
      expect(JSON.parse(stableJsonStringify(record))).toMatchObject({ status });
    },
  );

  it('fails enforcement for required failed and not-evaluated criteria', () => {
    for (const status of ['failed', 'not_evaluated'] as const) {
      const evidence = document();
      evidence.criteria = evidence.criteria.map(record => (
        record.id === 'unattended-runtime-throughput'
          ? criterion(record.id, status)
          : record
      ));
      expect(soakEnforcementFailures(evidence)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`required criterion unattended-runtime-throughput is ${status}`),
        ]),
      );
    }
  });

  it('rejects missing, duplicate, and malformed criterion evidence', () => {
    const missing = document();
    missing.criteria.pop();
    expect(validateSoakEvidence(missing)).toEqual(
      expect.arrayContaining([expect.stringContaining('missing criterion')]),
    );

    const duplicate = document();
    duplicate.criteria.push(duplicate.criteria[0]!);
    expect(validateSoakEvidence(duplicate)).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate criterion')]),
    );

    const malformed = criterion('unattended-runtime-throughput') as unknown as {
      provenance: { sources: string[] };
    };
    malformed.provenance.sources = [];
    expect(validateSoakCriterion(malformed, 'smoke')).toEqual(
      expect.arrayContaining([expect.stringContaining('provenance')]),
    );
  });

  it('rejects missing scheduled fault evidence and passed snapshot errors', () => {
    const missingFault = document();
    missingFault.runIdentity.configuration.scheduledFaultIds = ['day-2:lease-expiry'];
    expect(validateSoakEvidence(missingFault)).toEqual(
      expect.arrayContaining([expect.stringContaining('scheduled matrix')]),
    );

    const snapshotError = document();
    snapshotError.runIdentity.configuration.scheduledFaultIds = ['day-2:lease-expiry'];
    snapshotError.faultEvidence = [{
      id: 'day-2:lease-expiry',
      day: 2,
      kind: 'lease-expiry',
      status: 'passed',
      before: { captureError: 'unavailable' },
      fault: { attempted: true },
      after: { captured: true },
      provenance: ['fixture'],
    }];
    expect(validateSoakEvidence(snapshotError)).toEqual(
      expect.arrayContaining([expect.stringContaining('snapshot capture error')]),
    );
  });

  it('sorts object keys for deterministic JSON and enforces acceptance identity', () => {
    expect(stableJsonStringify({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}');

    const evidence = document();
    evidence.runIdentity = {
      ...identity(),
      mode: 'acceptance',
      authoritative: false,
      days: 28,
      activitiesPerDay: 20,
      learningEnabled: true,
    };
    expect(validateSoakEvidence(evidence)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('authoritative 28x20 contract'),
      ]),
    );
  });
});
