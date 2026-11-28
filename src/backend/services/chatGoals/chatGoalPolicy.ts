// Decides what a chat goal does after a turn: go on, wait for a retry, pause or finish.
import type { FlujoChatMessage } from '@/shared/types/chat';
import {
  CHAT_GOAL_FAILED_ROUNDS,
  CHAT_GOAL_QUIET_ROUNDS,
  type ChatGoal,
  type ChatGoalPauseReason,
} from '@/shared/types/chatGoal';
import type { SharedState } from '@/backend/execution/flow/types';
import { classifyRecoveryFailure } from '@/backend/execution/flow/recoveryCheckpoint';

export const GOAL_ACHIEVED_LINE = 'GOAL ACHIEVED';
export const GOAL_BLOCKED_LINE = 'GOAL BLOCKED';
/** How long FLUJO waits after a failed goal turn; doubles per failure up to the maximum. */
export const GOAL_RETRY_BASE_MS = 60_000;
export const GOAL_RETRY_MAX_MS = 15 * 60_000;
/** How long FLUJO waits when it is too busy to start a goal turn. */
export const GOAL_BUSY_RETRY_MS = 30_000;
const NOTE_LIMIT = 280;
const DETAIL_LIMIT = 500;

/** How the chat's last turn ended, as far as the goal cares. */
export type ChatTurnOutcome =
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'failed'; retryable: boolean; message: string; retryAfterAt?: number }
  /** Still running, waiting for an approval or the debugger, or cut off by a restart. */
  | { kind: 'waiting' };

export type SettledTurnOutcome = Exclude<ChatTurnOutcome, { kind: 'waiting' }>;

export type GoalVerdict = { kind: 'achieved' } | { kind: 'blocked'; detail?: string };

export interface ChatTurnReview {
  lastMessageId?: string;
  /** The person wrote in the chat (a new message or a correction during a reply). */
  personWrote: boolean;
  /** A goal turn of this goal is among the new messages. */
  goalTurnSeen: boolean;
  /** The goal turn FLUJO started is in the chat. */
  pendingTurnLanded: boolean;
  usedTools: boolean;
  verdict?: GoalVerdict;
  note?: string;
}

/** What FLUJO sends the agent to start goal turn `round`. */
export function chatGoalTurnText(goal: Pick<ChatGoal, 'text' | 'quietRounds'>, round: number): string {
  const lines = [
    `Goal (round ${round}): ${goal.text}`,
    '',
    round === 1
      ? 'Work on this goal on your own. After each reply FLUJO asks you to go on until the goal is met, so do not wait for the person. In each turn, take the next useful step and check what it did.'
      : 'Keep going: take the next useful step toward the goal and check what it did.',
  ];
  if (goal.quietRounds > 0) {
    lines.push('Your last reply took no action. Do something concrete now, for example with your tools, or say what blocks you.');
  }
  lines.push(
    `When the goal is met and you have checked it, end your reply with the line ${GOAL_ACHIEVED_LINE}.`,
    `If it cannot be met, or you need something only the person can give, end your reply with ${GOAL_BLOCKED_LINE}: and what you need.`,
  );
  return lines.join('\n');
}

function messageText(message: FlujoChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

const VERDICT_LINE = /^GOAL\s+(ACHIEVED|BLOCKED)\b\s*[:.\-–—]?\s*(.*)$/i;

/** The agent's verdict line ("GOAL ACHIEVED" or "GOAL BLOCKED: …"), and its reply without it. */
export function parseGoalVerdict(text: string): { verdict?: GoalVerdict; rest: string } {
  let verdict: GoalVerdict | undefined;
  const rest: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line.replace(/[*_`>#~]/g, '').trim());
    if (!match) {
      rest.push(line);
      continue;
    }
    const detail = match[2].trim();
    verdict = match[1].toUpperCase() === 'ACHIEVED'
      ? { kind: 'achieved' }
      : { kind: 'blocked', ...(detail ? { detail } : {}) };
  }
  return { verdict, rest: rest.join('\n') };
}

function shorten(text: string, limit: number): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function isPersonMessage(message: FlujoChatMessage): boolean {
  return message.role === 'user' && !message.goalTurn && !message.agentMessage && !message.triggerEvent
    && !((message.depth ?? 0) > 0);
}

/** What happened in the chat since FLUJO last looked at it for this goal. */
export function reviewChatTurn(messages: readonly FlujoChatMessage[], goal: ChatGoal): ChatTurnReview {
  const reviewed = goal.reviewedMessageId ? messages.findIndex((message) => message.id === goal.reviewedMessageId) : -1;
  let start = reviewed + 1;
  if (goal.reviewedMessageId && reviewed < 0) {
    // The chat was edited or reverted: look at its latest turn only.
    const lastUser = messages.map((message) => message.role).lastIndexOf('user');
    start = Math.max(0, lastUser);
  }
  const fresh = messages.slice(start);
  const lastReply = [...fresh].reverse().find((message) => message.role === 'assistant' && messageText(message).trim());
  const parsed = lastReply ? parseGoalVerdict(messageText(lastReply)) : undefined;
  return {
    lastMessageId: messages.at(-1)?.id,
    personWrote: fresh.some(isPersonMessage),
    goalTurnSeen: fresh.some((message) => message.goalTurn?.goalId === goal.id),
    pendingTurnLanded: !goal.turn || messages.some((message) => message.id === goal.turn!.messageId),
    usedTools: fresh.some((message) => message.role === 'tool'
      || (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0)),
    verdict: parsed?.verdict,
    note: parsed ? shorten(parsed.rest, NOTE_LIMIT) : undefined,
  };
}

/** How the last turn of a chat ended, from its saved state. */
export function chatTurnOutcome(state: Pick<SharedState, 'status' | 'recovery' | 'lastResponse' | 'lastError'>): ChatTurnOutcome {
  if (state.status === 'running' || state.status === 'awaiting_tool_approval' || state.status === 'paused_debug') {
    return { kind: 'waiting' };
  }
  const classification = state.recovery?.classification;
  if (classification === 'interrupted') return { kind: 'waiting' };
  if (classification === 'cancelled') return { kind: 'stopped' };
  if (state.status !== 'error' && classification !== 'retryable_failure' && classification !== 'permanent_failure') {
    return { kind: 'done' };
  }
  const classified = classifyRecoveryFailure(state.lastResponse);
  const failure = state.recovery?.failure ?? classified.failure;
  return {
    kind: 'failed',
    retryable: classification ? classification === 'retryable_failure' : failure.retryable,
    message: state.lastError?.message || failure.message || 'The reply failed.',
    ...(state.recovery?.retryAfterAt ?? classified.retryAfterAt
      ? { retryAfterAt: state.recovery?.retryAfterAt ?? classified.retryAfterAt } : {}),
  };
}

function paused(goal: ChatGoal, reason: ChatGoalPauseReason, detail: string | undefined, now: number): ChatGoal {
  const short = detail ? shorten(detail, DETAIL_LIMIT) : undefined;
  return { ...goal, state: 'paused', pause: { reason, ...(short ? { detail: short } : {}), at: now }, retryAt: undefined };
}

function resumed(goal: ChatGoal): ChatGoal {
  return { ...goal, state: 'active', pause: undefined, quietRounds: 0, failedRounds: 0, retryAt: undefined };
}

function failed(goal: ChatGoal, failure: { retryable: boolean; message: string; retryAfterAt?: number }, now: number): ChatGoal {
  const failedRounds = goal.failedRounds + 1;
  if (!failure.retryable || failedRounds > CHAT_GOAL_FAILED_ROUNDS) {
    return paused({ ...goal, failedRounds }, 'error', failure.message, now);
  }
  const backoff = Math.min(GOAL_RETRY_MAX_MS, GOAL_RETRY_BASE_MS * 2 ** (failedRounds - 1));
  return { ...goal, failedRounds, retryAt: Math.max(now + backoff, failure.retryAfterAt ?? 0) };
}

/**
 * The goal after FLUJO looked at a finished turn. The agent's own verdict wins;
 * a goal that waits for the person goes on once the person writes (unless they
 * paused it themselves); turns that do nothing, failures and Stop pause it.
 */
export function settleChatGoal(goal: ChatGoal, review: ChatTurnReview, outcome: SettledTurnOutcome, now: number): ChatGoal {
  const next: ChatGoal = {
    ...goal,
    updatedAt: now,
    reviewedMessageId: review.lastMessageId ?? goal.reviewedMessageId,
    turn: undefined,
    ...(review.note ? { lastNote: review.note } : {}),
  };
  if (review.verdict?.kind === 'achieved' && goal.state !== 'achieved') {
    return { ...next, state: 'achieved', achievedAt: now, pause: undefined, retryAt: undefined, quietRounds: 0, failedRounds: 0 };
  }
  if (goal.state !== 'active') {
    const personCanResume = goal.state === 'paused' && goal.pause?.reason !== 'person';
    return personCanResume && review.personWrote && outcome.kind === 'done' ? resumed(next) : next;
  }
  if (goal.turn && !review.pendingTurnLanded) {
    return failed(next, { retryable: true, message: 'The goal turn did not start.' }, now);
  }
  if (review.verdict?.kind === 'blocked') return paused(next, 'blocked', review.verdict.detail ?? review.note, now);
  if (outcome.kind === 'stopped') return paused(next, 'stopped', undefined, now);
  if (outcome.kind === 'failed') return failed(next, outcome, now);
  const settled: ChatGoal = { ...next, failedRounds: 0, retryAt: undefined };
  if (review.personWrote || review.usedTools) return { ...settled, quietRounds: 0 };
  if (!review.goalTurnSeen) return settled;
  const quietRounds = goal.quietRounds + 1;
  return quietRounds >= CHAT_GOAL_QUIET_ROUNDS
    ? paused({ ...settled, quietRounds }, 'no_progress', undefined, now)
    : { ...settled, quietRounds };
}

export function canStartChatGoalTurn(goal: ChatGoal, now: number): boolean {
  return goal.state === 'active' && !goal.turn && (goal.retryAt === undefined || goal.retryAt <= now);
}

export function beginChatGoalTurn(goal: ChatGoal, messageId: string, now: number): ChatGoal {
  const round = goal.rounds + 1;
  return { ...goal, rounds: round, turn: { messageId, round, startedAt: now }, retryAt: undefined, updatedAt: now };
}
