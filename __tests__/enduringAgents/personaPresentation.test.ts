import {
  projectPersonaRuntimePresentation,
  type PersonaExecutionVisualState,
  type Persona,
  type PersonaActivity,
} from '@/shared/types/enduringAgent';

const persona: Persona = {
  schemaVersion: 1,
  id: 'persona_visual',
  name: 'Visual Persona',
  roleVersionId: 'role_visual',
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

function activity(status: PersonaActivity['status']): PersonaActivity {
  return {
    schemaVersion: 1,
    id: `activity_${status}`,
    personaId: persona.id,
    kind: 'voice',
    status,
    source: { kind: 'voice' },
    createdAt: 3,
    updatedAt: 4,
  };
}

describe('projectPersonaRuntimePresentation', () => {
  it.each([
    ['queued', undefined, 'thinking'],
    ['running', undefined, 'thinking'],
    ['running', 'using_app', 'using_app'],
    ['running', 'speaking', 'speaking'],
    ['waiting', 'speaking', 'waiting'],
    ['completed', 'speaking', 'idle'],
    ['cancelled', undefined, 'idle'],
    ['error', undefined, 'error'],
  ] as Array<[
    PersonaActivity['status'],
    'using_app' | 'speaking' | undefined,
    PersonaExecutionVisualState,
  ]>)('maps %s execution to %s', (status, cue, expected) => {
    expect(projectPersonaRuntimePresentation(persona, activity(status), cue)).toMatchObject({
      personaId: persona.id,
      activityId: `activity_${status}`,
      state: expected,
      avatarUrl: 'https://example.test/avatar.png',
      voice: 'alloy',
      language: 'en-US',
      updatedAt: 4,
    });
  });

  it('supports a pre-dispatch listening state without creating execution authority', () => {
    expect(projectPersonaRuntimePresentation(persona, undefined, 'listening')).toEqual({
      personaId: persona.id,
      state: 'listening',
      avatarUrl: 'https://example.test/avatar.png',
      voice: 'alloy',
      language: 'en-US',
      updatedAt: 2,
    });
  });

  it('rejects presentation projection across Persona boundaries', () => {
    expect(() => projectPersonaRuntimePresentation(persona, {
      ...activity('running'),
      personaId: 'persona_other',
    })).toThrow(/another Persona/i);
  });
});
