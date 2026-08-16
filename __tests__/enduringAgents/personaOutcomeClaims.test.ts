import { semanticOutcomeFromDispatch } from '@/backend/services/enduringAgents/personaDispatcher';

function outcome(outputText?: string) {
  return {
    status: 'completed' as const,
    personaId: 'persona_claims',
    activityId: 'activity_claims',
    behaviorRevisionId: 'revision_claims',
    ...(outputText ? { outputText } : {}),
  };
}

describe('Persona Activity semantic outcome claims', () => {
  it('accepts one bounded owning-Activity claim', () => {
    const claim = {
      resolution: 'succeeded',
      summary: 'The requested result was verified.',
      evidenceRefs: [{ kind: 'activity', id: 'activity_claims' }],
    };
    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      outcome: outcome(
        '<persona_activity_outcome>' + JSON.stringify(claim)
        + '</persona_activity_outcome>',
      ),
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({
      resolution: 'succeeded',
      decisionSource: 'persona_claim',
      summary: 'The requested result was verified.',
      decidedAt: 100,
    });
  });

  it('downgrades missing, malformed, and foreign-evidence claims to unknown', () => {
    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      outcome: outcome('ordinary completion prose'),
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({ resolution: 'unknown', decisionSource: 'engine' });

    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      outcome: outcome('<persona_activity_outcome>{bad json}</persona_activity_outcome>'),
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({
      resolution: 'unknown',
      decisionSource: 'engine',
      summary: expect.stringContaining('malformed'),
    });

    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      outcome: outcome(
        '<persona_activity_outcome>'
        + JSON.stringify({
          resolution: 'succeeded',
          evidenceRefs: [{ kind: 'activity', id: 'activity_foreign' }],
        })
        + '</persona_activity_outcome>',
      ),
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({
      resolution: 'unknown',
      decisionSource: 'engine',
      summary: expect.stringContaining('outside the owning Activity'),
    });
  });

  it('maps runtime error to failed independently from claim text', () => {
    expect(semanticOutcomeFromDispatch({
      status: 'error',
      outcome: outcome(
        '<persona_activity_outcome>'
        + JSON.stringify({ resolution: 'succeeded', evidenceRefs: [] })
        + '</persona_activity_outcome>',
      ),
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({
      resolution: 'failed',
      blockerKind: 'unknown',
      decisionSource: 'engine',
    });
  });
});
