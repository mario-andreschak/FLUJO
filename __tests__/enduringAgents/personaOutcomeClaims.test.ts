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
  it('uses a fenced native outcome without requiring hidden markup in final prose', () => {
    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      outcome: outcome('Research saved; continuing after the service recovers.'),
      reportedOutcome: {
        schemaVersion: 1,
        resolution: 'partial',
        summary: 'Saved the verified research sources.',
        nextAction: 'Publish the prepared article after the temporary outage.',
        blockerKind: 'transient',
        retryAfterMs: 120_000,
        goalAchieved: false,
        decisionSource: 'persona_claim',
        evidenceRefs: [{ kind: 'activity', id: 'activity_claims' }],
        decidedAt: 90,
      },
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({
      resolution: 'partial',
      nextAction: 'Publish the prepared article after the temporary outage.',
      retryAfterMs: 120_000,
      goalAchieved: false,
      decidedAt: 100,
    });
  });

  it.each(['error', 'cancelled'] as const)('does not let a prior success report override a runtime %s', (status) => {
    const result = semanticOutcomeFromDispatch({
      status,
      reportedOutcome: {
        schemaVersion: 1,
        resolution: 'succeeded',
        goalAchieved: true,
        decisionSource: 'persona_claim',
        evidenceRefs: [{ kind: 'activity', id: 'activity_claims' }],
        decidedAt: 90,
      },
      activityId: 'activity_claims',
      decidedAt: 100,
    });
    expect(result.resolution).toBe(status === 'error' ? 'failed' : 'unknown');
    expect(result.goalAchieved).toBeUndefined();
  });

  it('rejects a stored report for a different Activity', () => {
    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      reportedOutcome: {
        schemaVersion: 1,
        resolution: 'succeeded',
        decisionSource: 'persona_claim',
        evidenceRefs: [{ kind: 'activity', id: 'other_activity' }],
        decidedAt: 90,
      },
      activityId: 'activity_claims',
      decidedAt: 100,
    }).resolution).toBe('unknown');
  });

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

  it('downgrades contradictory legacy claims before the terminal transition', () => {
    expect(semanticOutcomeFromDispatch({
      status: 'completed',
      outcome: outcome('<persona_activity_outcome>'
        + JSON.stringify({ resolution: 'succeeded', blockerKind: 'permission', goalAchieved: true })
        + '</persona_activity_outcome>'),
      activityId: 'activity_claims',
      decidedAt: 100,
    })).toMatchObject({ resolution: 'unknown', decisionSource: 'engine' });
  });
});
