import type { ExecutionEvent } from '@/shared/types/execution/events';
import type {
  Persona,
  PersonaActivity,
} from '@/shared/types/enduringAgent';
import {
  PersonaVoiceAdapter,
  type PersonaVoiceAdapterDependencies,
} from '@/backend/services/enduringAgents/personaVoiceAdapter';
import type { PersonaFlowDispatchSubmission } from
  '@/backend/services/enduringAgents/personaDispatcher';

function persona(): Persona {
  return {
    schemaVersion: 1,
    id: 'persona_voice',
    name: 'Voice Persona',
    roleVersionId: 'role_voice',
    lifecycleState: 'idle',
    presentation: {
      avatarUrl: 'https://example.test/avatar.png',
      voice: 'alloy',
      language: 'en-US',
    },
    autonomyLevel: 'locked',
    interruptionPolicy: 'queue',
    createdAt: 1,
    updatedAt: 2,
  };
}

function activity(overrides: Partial<PersonaActivity> = {}): PersonaActivity {
  return {
    schemaVersion: 1,
    id: 'activity_voice',
    personaId: 'persona_voice',
    kind: 'voice',
    status: 'completed',
    source: { kind: 'voice', sourceId: 'session-1' },
    behaviorRevisionId: 'revision_voice',
    conversationId: 'conversation_voice',
    runId: 'run_voice',
    createdAt: 3,
    updatedAt: 4,
    startedAt: 3,
    completedAt: 4,
    ...overrides,
  };
}

function submission(): PersonaFlowDispatchSubmission {
  return {
    decision: 'queued',
    dispatch: {
      id: 'dispatch_voice',
      personaId: 'persona_voice',
      state: 'queued',
    },
  } as PersonaFlowDispatchSubmission;
}

function dependencies(
  overrides: Partial<PersonaVoiceAdapterDependencies> = {},
): PersonaVoiceAdapterDependencies {
  return {
    getPersona: jest.fn(async () => persona()),
    getPersonaActivity: jest.fn(async () => activity()),
    submitPersonaFlowDispatch: jest.fn(async () => submission()),
    flushConversationLog: jest.fn(async () => {}),
    readConversationLog: jest.fn(async () => []),
    ...overrides,
  };
}

describe('PersonaVoiceAdapter', () => {
  it('routes direct voice through the durable Persona dispatcher with presentation defaults', async () => {
    const deps = dependencies();
    const adapter = new PersonaVoiceAdapter(deps);

    const result = await adapter.submit({
      personaId: 'persona_voice',
      idempotencyKey: 'voice-retry-1',
      sessionId: 'session-1',
      transcript: {
        text: 'Please continue the investigation.',
        capturedAt: 10,
        confidence: 0.98,
      },
    }, { startPump: false });

    expect(deps.submitPersonaFlowDispatch).toHaveBeenCalledTimes(1);
    const [input, options] = jest.mocked(deps.submitPersonaFlowDispatch).mock.calls[0];
    expect(input).toMatchObject({
      personaId: 'persona_voice',
      idempotencyKey: 'voice-retry-1',
      kind: 'voice',
      source: { kind: 'voice', sourceId: 'session-1' },
      relationKey: result.conversationId,
      relatedAction: 'steer',
      flowInput: {
        mode: 'conversation',
        conversationId: result.conversationId,
        source: 'chat',
        userTurn: true,
        messages: [{
          id: result.transcriptId,
          role: 'user',
          content: 'Please continue the investigation.',
          timestamp: 0,
          voiceTranscript: {
            sessionId: 'session-1',
            entryMode: 'direct',
            language: 'en-US',
            capturedAt: 10,
            confidence: 0.98,
          },
        }],
      },
    });
    expect(options).toEqual({ startPump: false });
    expect(result.presentation).toEqual({
      avatarUrl: 'https://example.test/avatar.png',
      voice: 'alloy',
      language: 'en-US',
    });
  });

  it('routes chained voice through the same mailbox path with explicit ancestry', async () => {
    const deps = dependencies();
    const adapter = new PersonaVoiceAdapter(deps);

    await adapter.submit({
      personaId: 'persona_voice',
      idempotencyKey: 'voice-chain-retry',
      sessionId: 'session-chain',
      transcript: { text: 'Read this into the next chained turn.' },
      entryMode: 'chained',
      conversationId: 'conversation_chain',
      parentRunId: 'run_parent',
      relationKey: 'chain-thread-1',
      chainDepth: 2,
      language: 'es-CO',
      voice: 'custom-voice',
    });

    expect(deps.submitPersonaFlowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'voice',
        relationKey: 'chain-thread-1',
        relatedAction: 'steer',
        flowInput: expect.objectContaining({
          conversationId: 'conversation_chain',
          parentRunId: 'run_parent',
          source: 'subflow',
          chainDepth: 2,
        }),
      }),
      { waitForCompletion: false },
    );
  });

  it('derives stable conversation and transcript ids across identical retries', async () => {
    const deps = dependencies();
    const adapter = new PersonaVoiceAdapter(deps);
    const input = {
      personaId: 'persona_voice',
      idempotencyKey: 'same-retry',
      sessionId: 'same-session',
      transcript: { text: 'Same durable turn.' },
    };

    const first = await adapter.submit(input);
    const second = await adapter.submit(input);

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.transcriptId).toBe(first.transcriptId);
    expect(jest.mocked(deps.submitPersonaFlowDispatch).mock.calls[1][0])
      .toEqual(jest.mocked(deps.submitPersonaFlowDispatch).mock.calls[0][0]);
  });

  it('rejects chained voice without explicit parent-run continuity', async () => {
    const deps = dependencies();
    const adapter = new PersonaVoiceAdapter(deps);

    await expect(adapter.submit({
      personaId: 'persona_voice',
      idempotencyKey: 'missing-parent',
      sessionId: 'session-chain',
      transcript: { text: 'Cannot orphan this chained turn.' },
      entryMode: 'chained',
    })).rejects.toThrow(/parentRunId/i);
    expect(deps.submitPersonaFlowDispatch).not.toHaveBeenCalled();
  });

  it('loads the persisted transcript only when Activity attribution matches', async () => {
    const events = [{
      type: 'message',
      conversationId: 'conversation_voice',
      seq: 0,
      timestamp: 5,
      message: {
        id: 'voice_message',
        role: 'user',
        content: 'Persisted voice transcript.',
        timestamp: 5,
      },
    }] as ExecutionEvent[];
    const deps = dependencies({
      readConversationLog: jest.fn(async () => events),
    });
    const adapter = new PersonaVoiceAdapter(deps);

    const transcript = await adapter.loadActivityTranscript({
      personaId: 'persona_voice',
      activityId: 'activity_voice',
      behaviorRevisionId: 'revision_voice',
      conversationId: 'conversation_voice',
    });

    expect(deps.flushConversationLog).toHaveBeenCalledWith('conversation_voice');
    expect(transcript).toEqual({
      attribution: {
        personaId: 'persona_voice',
        activityId: 'activity_voice',
        behaviorRevisionId: 'revision_voice',
      },
      conversationId: 'conversation_voice',
      runId: 'run_voice',
      messages: [expect.objectContaining({
        id: 'voice_message',
        content: 'Persisted voice transcript.',
      })],
    });
  });

  it('fails closed for foreign Activity attribution', async () => {
    const deps = dependencies();
    const adapter = new PersonaVoiceAdapter(deps);

    await expect(adapter.loadActivityTranscript({
      personaId: 'persona_other',
      activityId: 'activity_voice',
      behaviorRevisionId: 'revision_voice',
    })).rejects.toThrow(/attribution does not match/i);
    expect(deps.readConversationLog).not.toHaveBeenCalled();
  });
});
