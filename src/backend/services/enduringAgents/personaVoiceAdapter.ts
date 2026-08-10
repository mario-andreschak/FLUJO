import { z } from 'zod';

import {
  flushConversationLog,
  projectMessages,
  readConversationLog,
} from '@/backend/execution/flow/conversationLog';
import type { FlujoChatMessage } from '@/shared/types/chat';
import {
  EnduringAgentIdSchema,
  type Persona,
  type PersonaActivity,
  type PersonaAttribution,
  type PersonaPresentation,
} from '@/shared/types/enduringAgent';

import { stableEnduringAgentId } from './ids';
import {
  submitPersonaFlowDispatch,
  type PersonaFlowDispatchSubmission,
  type SubmitPersonaFlowDispatchOptions,
} from './personaDispatcher';
import {
  getPersona,
  getPersonaActivity,
} from './store';

const VoiceTurnInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256).optional(),
  personaId: EnduringAgentIdSchema,
  idempotencyKey: z.string().trim().min(1).max(512),
  sessionId: z.string().trim().min(1).max(512),
  transcriptId: EnduringAgentIdSchema.optional(),
  transcript: z.object({
    text: z.string().trim().min(1).max(1_000_000),
    capturedAt: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
  }).strict(),
  entryMode: z.enum(['direct', 'chained']).default('direct'),
  conversationId: EnduringAgentIdSchema.optional(),
  parentRunId: EnduringAgentIdSchema.optional(),
  relationKey: z.string().trim().min(1).max(512).optional(),
  relatedAction: z.enum(['steer', 'coalesce']).default('steer'),
  behaviorSlotKey: z.string().trim().min(1).max(128).optional(),
  language: z.string().trim().min(1).max(128).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  chainDepth: z.number().int().nonnegative().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.entryMode === 'chained' && !input.parentRunId) {
    ctx.addIssue({
      code: 'custom',
      message: 'Chained voice input requires parentRunId.',
      path: ['parentRunId'],
    });
  }
});

const TranscriptIdentitySchema = z.object({
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  behaviorRevisionId: EnduringAgentIdSchema,
  conversationId: EnduringAgentIdSchema.optional(),
}).strict();

type ParsedVoiceTurnInput = z.infer<typeof VoiceTurnInputSchema>;

export interface PersonaVoiceTranscriptInput {
  text: string;
  capturedAt?: number;
  confidence?: number;
}

export interface SubmitPersonaVoiceTurnInput {
  workspaceId?: string;
  personaId: string;
  idempotencyKey: string;
  /** Stable voice-session identity used for mailbox continuity. */
  sessionId: string;
  /** Stable STT segment identity. Derived from the retry key when omitted. */
  transcriptId?: string;
  transcript: PersonaVoiceTranscriptInput;
  entryMode?: 'direct' | 'chained';
  conversationId?: string;
  /** Required for chained voice so run ancestry remains explicit. */
  parentRunId?: string;
  relationKey?: string;
  relatedAction?: 'steer' | 'coalesce';
  behaviorSlotKey?: string;
  language?: string;
  voice?: string;
  chainDepth?: number;
}

export interface PersonaVoiceTurnSubmission extends PersonaFlowDispatchSubmission {
  conversationId: string;
  transcriptId: string;
  presentation: PersonaPresentation;
}

export interface PersonaActivityTranscript {
  attribution: Required<PersonaAttribution>;
  conversationId: string;
  runId?: string;
  messages: FlujoChatMessage[];
}

export interface PersonaVoiceAdapterDependencies {
  getPersona: (personaId: string) => Promise<Persona | null>;
  getPersonaActivity: (activityId: string) => Promise<PersonaActivity | null>;
  submitPersonaFlowDispatch: typeof submitPersonaFlowDispatch;
  flushConversationLog: typeof flushConversationLog;
  readConversationLog: typeof readConversationLog;
}

const defaultDependencies: PersonaVoiceAdapterDependencies = {
  getPersona,
  getPersonaActivity,
  submitPersonaFlowDispatch,
  flushConversationLog,
  readConversationLog,
};

type VoiceTranscriptMessage = FlujoChatMessage & {
  voiceTranscript: {
    sessionId: string;
    entryMode: 'direct' | 'chained';
    language?: string;
    confidence?: number;
    capturedAt?: number;
  };
};

function presentationFor(
  persona: Persona,
  input: ParsedVoiceTurnInput,
): PersonaPresentation {
  return {
    ...(persona.presentation?.avatarUrl
      ? { avatarUrl: persona.presentation.avatarUrl }
      : {}),
    ...(input.voice ?? persona.presentation?.voice
      ? { voice: input.voice ?? persona.presentation?.voice }
      : {}),
    ...(input.language ?? persona.presentation?.language
      ? { language: input.language ?? persona.presentation?.language }
      : {}),
  };
}

/**
 * Voice ingress is an adapter over the durable Persona dispatcher. It never
 * calls runFlow or claims a lease itself, so text and voice obey the same
 * queueing, steering, idempotency, fencing, and recovery semantics.
 */
export class PersonaVoiceAdapter {
  constructor(
    private readonly dependencies: PersonaVoiceAdapterDependencies = defaultDependencies,
  ) {}

  async submit(
    value: SubmitPersonaVoiceTurnInput,
    options: SubmitPersonaFlowDispatchOptions = { waitForCompletion: false },
  ): Promise<PersonaVoiceTurnSubmission> {
    const input = VoiceTurnInputSchema.parse(value);
    const persona = await this.dependencies.getPersona(input.personaId);
    if (!persona || persona.id !== input.personaId) {
      throw new Error(`Persona ${JSON.stringify(input.personaId)} not found in this workspace.`);
    }

    const conversationId = input.conversationId ?? stableEnduringAgentId('voiceconv', {
      purpose: 'persona-voice-conversation-v1',
      personaId: input.personaId,
      sessionId: input.sessionId,
    });
    const transcriptId = input.transcriptId ?? stableEnduringAgentId('voiceturn', {
      purpose: 'persona-voice-turn-v1',
      personaId: input.personaId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
    });
    const presentation = presentationFor(persona, input);
    const message: VoiceTranscriptMessage = {
      id: transcriptId,
      role: 'user',
      content: input.transcript.text,
      // The dispatcher replaces related-input timestamps with its durable
      // creation time. A constant also keeps retries hash-identical.
      timestamp: 0,
      voiceTranscript: {
        sessionId: input.sessionId,
        entryMode: input.entryMode,
        ...(presentation.language ? { language: presentation.language } : {}),
        ...(input.transcript.confidence !== undefined
          ? { confidence: input.transcript.confidence }
          : {}),
        ...(input.transcript.capturedAt !== undefined
          ? { capturedAt: input.transcript.capturedAt }
          : {}),
      },
    };

    const submission = await this.dependencies.submitPersonaFlowDispatch({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      personaId: input.personaId,
      idempotencyKey: input.idempotencyKey,
      kind: 'voice',
      source: { kind: 'voice', sourceId: input.sessionId },
      ...(input.behaviorSlotKey ? { behaviorSlotKey: input.behaviorSlotKey } : {}),
      relationKey: input.relationKey ?? conversationId,
      relatedAction: input.relatedAction,
      summary: input.entryMode === 'chained'
        ? 'Chained voice transcript'
        : 'Direct voice transcript',
      flowInput: {
        messages: [message],
        mode: 'conversation',
        conversationId,
        userTurn: true,
        source: input.entryMode === 'chained' ? 'subflow' : 'chat',
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        ...(input.chainDepth !== undefined ? { chainDepth: input.chainDepth } : {}),
      },
    }, options);

    return {
      ...submission,
      conversationId,
      transcriptId,
      presentation,
    };
  }

  /**
   * Read the existing durable conversation-log projection through an exact
   * Activity/Behavior attribution check. This does not create a parallel
   * transcript store; the lease-gated runFlow log remains authoritative.
   */
  async loadActivityTranscript(identity: {
    personaId: string;
    activityId: string;
    behaviorRevisionId: string;
    conversationId?: string;
  }): Promise<PersonaActivityTranscript> {
    const input = TranscriptIdentitySchema.parse(identity);
    const activity = await this.dependencies.getPersonaActivity(input.activityId);
    if (!activity) {
      throw new Error(`Persona Activity ${JSON.stringify(input.activityId)} was not found.`);
    }
    if (
      activity.personaId !== input.personaId
      || activity.behaviorRevisionId !== input.behaviorRevisionId
    ) {
      throw new Error('Persona Activity transcript attribution does not match.');
    }
    if (!activity.conversationId) {
      throw new Error('Persona Activity has no durable conversation transcript.');
    }
    if (input.conversationId && activity.conversationId !== input.conversationId) {
      throw new Error('Persona Activity transcript conversation does not match.');
    }

    await this.dependencies.flushConversationLog(activity.conversationId);
    const events = await this.dependencies.readConversationLog(activity.conversationId);

    return {
      attribution: {
        personaId: activity.personaId,
        activityId: activity.id,
        behaviorRevisionId: activity.behaviorRevisionId,
      },
      conversationId: activity.conversationId,
      ...(activity.runId ? { runId: activity.runId } : {}),
      messages: events ? projectMessages(events) : [],
    };
  }
}

const defaultAdapter = new PersonaVoiceAdapter();

export function submitPersonaVoiceTurn(
  input: SubmitPersonaVoiceTurnInput,
  options?: SubmitPersonaFlowDispatchOptions,
): Promise<PersonaVoiceTurnSubmission> {
  return defaultAdapter.submit(input, options);
}

export function loadPersonaActivityTranscript(identity: {
  personaId: string;
  activityId: string;
  behaviorRevisionId: string;
  conversationId?: string;
}): Promise<PersonaActivityTranscript> {
  return defaultAdapter.loadActivityTranscript(identity);
}
