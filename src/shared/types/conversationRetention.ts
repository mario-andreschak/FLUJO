/**
 * How long stored conversations are kept. Off unless a workspace turns it on.
 *
 * Both a workspace and a flow can name a period. Which wins is a workspace setting:
 *  - 'shorter' (default): the shorter of the two applies, so neither can keep text
 *    longer than the other allows. A flow's 0 adds no limit of its own.
 *  - 'flow': a flow's own value replaces the workspace's. A flow's 0 keeps its
 *    conversations for as long as the workspace is on.
 */
export type ConversationRetentionPrecedence = 'shorter' | 'flow';

export interface ConversationRetentionSettings {
  /** Missing or false: nothing is ever removed, whatever a flow says. */
  enabled?: boolean;
  /** Days since last activity. Missing or 0: only flows with their own period are affected. */
  days?: number;
  precedence?: ConversationRetentionPrecedence;
}

export const MAX_CONVERSATION_RETENTION_DAYS = 36_500;

export function isValidRetentionDays(value: unknown, allowZero = true): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= (allowZero ? 0 : 1) && value <= MAX_CONVERSATION_RETENTION_DAYS;
}

/**
 * The period for one conversation, in days, or `undefined` to keep it. An invalid
 * workspace or flow value counts as not set, so a typo can only ever keep more.
 */
export function effectiveRetentionDays(
  settings: ConversationRetentionSettings | undefined,
  flowDays: unknown,
): number | undefined {
  if (settings?.enabled !== true) return undefined;
  const workspace = isValidRetentionDays(settings.days) && settings.days > 0 ? settings.days : undefined;
  const flow = isValidRetentionDays(flowDays) ? flowDays : undefined;
  if (settings.precedence === 'flow') {
    if (flow === undefined) return workspace;
    return flow > 0 ? flow : undefined;
  }
  if (flow === undefined || flow === 0) return workspace;
  return workspace === undefined ? flow : Math.min(workspace, flow);
}

/** Why a conversation was kept. Reported as counts only, never with ids or text. */
export type ConversationRetentionKeepReason =
  | 'no_period'
  | 'recent'
  | 'running'
  | 'waiting'
  | 'persona'
  | 'protected'
  | 'schedule'
  | 'subflow_task'
  | 'meeting'
  | 'native_unresolved'
  | 'busy'
  | 'unreadable';

export interface ConversationRetentionReport {
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  scanned: number;
  /** Removed, or in a dry run how many would go. */
  deleted: number;
  /** Removed, with a leftover that is retried on the next run. */
  incomplete: number;
  failed: number;
  kept: Partial<Record<ConversationRetentionKeepReason, number>>;
  /** Stored output and error text cleared from scheduler run history. */
  runRecordsCleared: number;
  /** Recorded Harness examples removed for age. */
  harnessExamplesRemoved: number;
  /** Partial deletions finished from an earlier run or a restart. */
  resumedDeletions: number;
  /** Set when the run stopped early. A fixed code, never text from a conversation. */
  error?: string;
}

export interface ConversationRetentionStatus {
  enabled: boolean;
  days?: number;
  precedence: ConversationRetentionPrecedence;
  running: boolean;
  lastRun?: ConversationRetentionReport;
  lastDryRun?: ConversationRetentionReport;
}
