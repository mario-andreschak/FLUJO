import type {
  Persona,
  PersonaActivity,
  PersonaPresentation,
} from './enduringAgent';

export const PERSONA_EXECUTION_VISUAL_STATES = [
  'idle',
  'listening',
  'thinking',
  'using_app',
  'waiting',
  'speaking',
  'error',
] as const;

export type PersonaExecutionVisualState =
  (typeof PERSONA_EXECUTION_VISUAL_STATES)[number];

export type PersonaExecutionVisualCue =
  Extract<PersonaExecutionVisualState, 'listening' | 'thinking' | 'using_app' | 'speaking'>;

export interface PersonaRuntimePresentation extends PersonaPresentation {
  personaId: string;
  activityId?: string;
  state: PersonaExecutionVisualState;
  updatedAt: number;
}

/**
 * Project renderer-safe Persona state from the durable runtime. Presentation is
 * passive: it cannot acquire a lease, select tools, or become an execution
 * authority. Rich realtime renderers can consume this contract later.
 */
export function projectPersonaRuntimePresentation(
  persona: Persona,
  activity?: PersonaActivity,
  cue?: PersonaExecutionVisualCue,
): PersonaRuntimePresentation {
  if (activity && activity.personaId !== persona.id) {
    throw new TypeError('Cannot project an Activity owned by another Persona.');
  }

  let state: PersonaExecutionVisualState = 'idle';
  if (activity?.status === 'error') {
    state = 'error';
  } else if (activity?.status === 'waiting') {
    state = 'waiting';
  } else if (activity?.status === 'queued') {
    state = 'thinking';
  } else if (activity?.status === 'running') {
    state = cue ?? 'thinking';
  } else if (!activity && cue === 'listening') {
    state = 'listening';
  }

  return {
    personaId: persona.id,
    ...(activity ? { activityId: activity.id } : {}),
    state,
    ...(persona.presentation?.avatarUrl
      ? { avatarUrl: persona.presentation.avatarUrl }
      : {}),
    ...(persona.presentation?.voice
      ? { voice: persona.presentation.voice }
      : {}),
    ...(persona.presentation?.language
      ? { language: persona.presentation.language }
      : {}),
    updatedAt: Math.max(persona.updatedAt, activity?.updatedAt ?? 0),
  };
}
