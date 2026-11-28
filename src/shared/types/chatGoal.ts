/**
 * A goal in a chat with an agent (#1225): FLUJO keeps sending the agent a new
 * turn after each reply until the agent says the goal is met. One goal per chat.
 */

/** Longest goal text, like Claude Code's `/goal`. */
export const CHAT_GOAL_TEXT_LIMIT = 4_000;

/** Goal turns in a row that may do nothing before the goal pauses. */
export const CHAT_GOAL_QUIET_ROUNDS = 3;

/** Failed turns in a row that FLUJO retries before the goal pauses. */
export const CHAT_GOAL_FAILED_ROUNDS = 3;

export type ChatGoalState = 'active' | 'paused' | 'achieved';

/**
 * Why a goal waits. Only `person` (typed `/goal pause`) needs `/goal resume`;
 * after any other reason the person's next message lets the goal go on.
 */
export type ChatGoalPauseReason = 'person' | 'stopped' | 'no_progress' | 'blocked' | 'error';

export interface ChatGoalPause {
  reason: ChatGoalPauseReason;
  /** The agent's or the error's own words, when there are any. */
  detail?: string;
  at: number;
}

/** A goal turn FLUJO started and has not looked at since. */
export interface ChatGoalTurn {
  messageId: string;
  round: number;
  startedAt: number;
}

export interface ChatGoal {
  id: string;
  conversationId: string;
  text: string;
  state: ChatGoalState;
  createdAt: number;
  updatedAt: number;
  /** Turns FLUJO started for this goal. */
  rounds: number;
  /** Goal turns in a row that used no tool and gave no verdict. */
  quietRounds: number;
  /** Failed turns in a row. */
  failedRounds: number;
  /** FLUJO starts no turn before this time (after a failed turn or while FLUJO is busy). */
  retryAt?: number;
  pause?: ChatGoalPause;
  achievedAt?: number;
  /** The start of the agent's last reply, so the chat can show progress. */
  lastNote?: string;
  /** The last chat message FLUJO has already looked at for this goal. */
  reviewedMessageId?: string;
  turn?: ChatGoalTurn;
}

export interface ChatGoalResponse {
  goal: ChatGoal | null;
}

/** After setting or resuming: `running` says a reply is in progress, so the goal goes on after it. */
export interface ChatGoalUpdate extends ChatGoalResponse {
  running: boolean;
}

export type ChatGoalAction = 'pause' | 'resume';

/** Why the goal route refused, so the chat can say it in its own words. */
export type ChatGoalRefusal = 'persona_owned' | 'read_only' | 'protected' | 'not_found' | 'invalid_text' | 'no_goal';
