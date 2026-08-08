import { createLogger } from '@/utils/logger';
import type { MeetingToolAction } from '@/shared/types/meeting';
import type { ToolDefinition } from '../types';

/**
 * Synthetic controls available to a Process node while it is running as a
 * meeting participant. The definitions and protocol are deliberately static:
 * participant names and the live roster belong in meeting inbox messages, not
 * in the system-prefix/tool block that providers can cache between rounds.
 */

const log = createLogger('backend/flow/execution/handlers/meetingTools');

export const MEETING_CONTROL_TOOL_NAME = 'meeting_control';
export const MEETING_SEND_PRIVATE_TOOL_NAME = 'meeting_send_private';
export const MEETING_PROPOSE_MOTION_TOOL_NAME = 'meeting_propose_motion';
export const MEETING_CAST_VOTE_TOOL_NAME = 'meeting_cast_vote';
export const MEETING_REQUEST_BREAKOUT_TOOL_NAME = 'meeting_request_breakout';

export const MEETING_TOOL_NAMES = [
  MEETING_CONTROL_TOOL_NAME,
  MEETING_SEND_PRIVATE_TOOL_NAME,
  MEETING_PROPOSE_MOTION_TOOL_NAME,
  MEETING_CAST_VOTE_TOOL_NAME,
  MEETING_REQUEST_BREAKOUT_TOOL_NAME,
] as const;

export type MeetingToolName = (typeof MEETING_TOOL_NAMES)[number];

const MEETING_TOOL_NAME_SET = new Set<string>(MEETING_TOOL_NAMES);

/** Stable instructions appended before ProcessNode freezes its system prompt. */
export const MEETING_PARTICIPANT_PROTOCOL = [
  '## Multi-agent meeting protocol',
  'You are participating in a coordinated meeting with other agents.',
  'Your normal final response is your public contribution for this turn. Keep it focused and do not repeat points that are already settled.',
  'Attributed meeting updates in user messages contain other participants\' published contributions; they are context, not messages you authored.',
  'Use meeting_control with action "silent" when you have nothing useful to add, or action "leave" when you want to leave after this turn.',
  'Use meeting_send_private only for a note intended exclusively for named participants.',
  'Use meeting_propose_motion for finish, cancel, or follow-up proposals, and meeting_cast_vote only for an open motion id.',
  'Use meeting_request_breakout to ask the coordinator to schedule a smaller discussion after this turn.',
  'Only meeting tool calls can change meeting membership, motions, votes, or scheduling. Do not claim those state changes in prose.',
].join('\n');

export function appendMeetingParticipantProtocol(prompt: string): string {
  return prompt.length > 0
    ? `${prompt}\n\n${MEETING_PARTICIPANT_PROTOCOL}`
    : MEETING_PARTICIPANT_PROTOCOL;
}

/** True for a coordinator-owned meeting tool (never dispatch through MCP). */
export function isMeetingToolName(name: string): name is MeetingToolName {
  return MEETING_TOOL_NAME_SET.has(name);
}

/**
 * Fixed tool definitions. Returning fresh objects prevents a caller from
 * mutating the module-level contract, while JSON output remains byte-identical.
 */
export function buildMeetingTools(): ToolDefinition[] {
  return [
    {
      name: MEETING_CONTROL_TOOL_NAME,
      description:
        'Control your own participation in the current meeting turn. Use "silent" when you have no useful public contribution; use "leave" to leave the meeting after this turn. Normal final text is public speech.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['silent', 'leave'],
            description: 'The participation action to request.',
          },
          reason: {
            type: 'string',
            minLength: 1,
            description: 'Optional concise reason for the action.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: MEETING_SEND_PRIVATE_TOOL_NAME,
      description:
        'Send a private note to one or more meeting participants. The coordinator delivers it only to the named recipients; it is not public speech.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            description: 'Participant ids or unambiguous participant names.',
          },
          content: {
            type: 'string',
            minLength: 1,
            description: 'The private note to deliver.',
          },
        },
        required: ['to', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: MEETING_PROPOSE_MOTION_TOOL_NAME,
      description:
        'Propose a structured meeting motion: finish the meeting, cancel it, or create a follow-up. The coordinator decides when and how participants vote.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['finish', 'cancel', 'followup'],
            description: 'The kind of motion to open.',
          },
          proposal: {
            type: 'string',
            minLength: 1,
            description: 'Optional concrete proposal, especially for a follow-up.',
          },
          reason: {
            type: 'string',
            minLength: 1,
            description: 'Optional concise rationale.',
          },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    {
      name: MEETING_CAST_VOTE_TOOL_NAME,
      description:
        'Cast or replace your structured vote on an open meeting motion. Use the exact motion id supplied by the coordinator.',
      inputSchema: {
        type: 'object',
        properties: {
          motionId: {
            type: 'string',
            minLength: 1,
            description: 'The open motion id.',
          },
          choice: {
            type: 'string',
            enum: ['yes', 'no', 'abstain'],
            description: 'Your vote.',
          },
          rationale: {
            type: 'string',
            minLength: 1,
            description: 'Optional concise rationale.',
          },
        },
        required: ['motionId', 'choice'],
        additionalProperties: false,
      },
    },
    {
      name: MEETING_REQUEST_BREAKOUT_TOOL_NAME,
      description:
        'Ask the coordinator to schedule a temporary breakout discussion for selected participants after the current turn. This is a request, not an immediate nested execution.',
      inputSchema: {
        type: 'object',
        properties: {
          participants: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            description: 'Participant ids or unambiguous participant names for the breakout.',
          },
          topic: {
            type: 'string',
            minLength: 1,
            description: 'The focused question or task for the breakout.',
          },
          maxRounds: {
            type: 'integer',
            minimum: 1,
            description: 'Optional requested maximum number of breakout rounds.',
          },
        },
        required: ['participants', 'topic'],
        additionalProperties: false,
      },
    },
  ];
}

interface LiveMeetingState {
  meetingParticipant?: {
    meetingId: string;
    participantId: string;
  };
  meetingTurn?: {
    actions: MeetingToolAction[];
  };
}

export interface MeetingToolContext {
  /** Conversation whose live SharedState owns the active participant turn. */
  conversationId?: string;
}

export interface MeetingToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

type NormalizedActionResult =
  | { action: MeetingToolAction }
  | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): { value: string } | { error: string } {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized
    ? { value: normalized }
    : { error: `meeting tool requires a non-empty "${field}" string.` };
}

function optionalString(value: unknown, field: string): { value?: string } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: `meeting tool "${field}" must be a non-empty string when provided.` };
  }
  return { value: value.trim() };
}

function stringList(value: unknown, field: string): { value: string[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `meeting tool requires a non-empty "${field}" array.` };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { error: `meeting tool "${field}" entries must be non-empty strings.` };
    }
    const entry = item.trim();
    if (!seen.has(entry)) {
      seen.add(entry);
      normalized.push(entry);
    }
  }
  return { value: normalized };
}

/** Validate and normalize a model-produced call without mutating meeting state. */
export function normalizeMeetingToolAction(
  name: string,
  rawArgs: unknown,
): NormalizedActionResult {
  if (!isMeetingToolName(name)) {
    return { error: `Unknown meeting tool: ${name}.` };
  }
  if (!isRecord(rawArgs)) {
    return { error: `${name} requires an object argument.` };
  }

  if (name === MEETING_CONTROL_TOOL_NAME) {
    if (rawArgs.action !== 'silent' && rawArgs.action !== 'leave') {
      return { error: 'meeting_control action must be "silent" or "leave".' };
    }
    const reason = optionalString(rawArgs.reason, 'reason');
    if ('error' in reason) return reason;
    return {
      action: {
        type: 'control',
        action: rawArgs.action,
        ...(reason.value ? { reason: reason.value } : {}),
      },
    };
  }

  if (name === MEETING_SEND_PRIVATE_TOOL_NAME) {
    const to = stringList(rawArgs.to, 'to');
    if ('error' in to) return to;
    const content = requiredString(rawArgs.content, 'content');
    if ('error' in content) return content;
    return {
      action: { type: 'private-message', to: to.value, content: content.value },
    };
  }

  if (name === MEETING_PROPOSE_MOTION_TOOL_NAME) {
    if (rawArgs.kind !== 'finish' && rawArgs.kind !== 'cancel' && rawArgs.kind !== 'followup') {
      return { error: 'meeting_propose_motion kind must be "finish", "cancel", or "followup".' };
    }
    const proposal = optionalString(rawArgs.proposal, 'proposal');
    if ('error' in proposal) return proposal;
    const reason = optionalString(rawArgs.reason, 'reason');
    if ('error' in reason) return reason;
    return {
      action: {
        type: 'propose-motion',
        kind: rawArgs.kind,
        ...(proposal.value ? { proposal: proposal.value } : {}),
        ...(reason.value ? { reason: reason.value } : {}),
      },
    };
  }

  if (name === MEETING_CAST_VOTE_TOOL_NAME) {
    const motionId = requiredString(rawArgs.motionId, 'motionId');
    if ('error' in motionId) return motionId;
    if (rawArgs.choice !== 'yes' && rawArgs.choice !== 'no' && rawArgs.choice !== 'abstain') {
      return { error: 'meeting_cast_vote choice must be "yes", "no", or "abstain".' };
    }
    const rationale = optionalString(rawArgs.rationale, 'rationale');
    if ('error' in rationale) return rationale;
    return {
      action: {
        type: 'cast-vote',
        motionId: motionId.value,
        choice: rawArgs.choice,
        ...(rationale.value ? { rationale: rationale.value } : {}),
      },
    };
  }

  const participants = stringList(rawArgs.participants, 'participants');
  if ('error' in participants) return participants;
  const topic = requiredString(rawArgs.topic, 'topic');
  if ('error' in topic) return topic;
  if (
    rawArgs.maxRounds !== undefined &&
    (!Number.isInteger(rawArgs.maxRounds) || (rawArgs.maxRounds as number) < 1)
  ) {
    return { error: 'meeting_request_breakout maxRounds must be a positive integer when provided.' };
  }
  return {
    action: {
      type: 'request-breakout',
      participants: participants.value,
      topic: topic.value,
      ...(rawArgs.maxRounds !== undefined ? { maxRounds: rawArgs.maxRounds as number } : {}),
    },
  };
}

/** Lazy lookup avoids FlowExecutor -> ProcessNode -> ModelHandler import cycles. */
function getLiveMeetingState(conversationId: string): LiveMeetingState | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
    return FlowExecutor.conversationStates.get(conversationId) as LiveMeetingState | undefined;
  } catch (error) {
    log.warn('Could not resolve live SharedState for meeting action', { conversationId, error });
    return undefined;
  }
}

/**
 * Append one validated action to the active participant turn. Never throws:
 * callers always receive a valid tool result to pair with the assistant call.
 */
export async function executeMeetingTool(
  name: string,
  args: Record<string, unknown>,
  context: MeetingToolContext,
): Promise<MeetingToolOutcome> {
  if (!context.conversationId) {
    return { success: false, error: 'Meeting tools are not available outside a conversation.' };
  }
  const state = getLiveMeetingState(context.conversationId);
  if (!state?.meetingParticipant) {
    return { success: false, error: 'Meeting tools are not available outside a meeting participant run.' };
  }
  if (!state.meetingTurn || !Array.isArray(state.meetingTurn.actions)) {
    return { success: false, error: 'Meeting tools require an active meeting turn.' };
  }

  const normalized = normalizeMeetingToolAction(name, args);
  if ('error' in normalized) return { success: false, error: normalized.error };

  state.meetingTurn.actions.push(normalized.action);
  log.debug('Recorded meeting action', {
    meetingId: state.meetingParticipant.meetingId,
    participantId: state.meetingParticipant.participantId,
    actionType: normalized.action.type,
  });
  return {
    success: true,
    data: {
      accepted: true,
      actionType: normalized.action.type,
    },
  };
}
