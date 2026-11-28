import type { TranslationValues } from '@/frontend/i18n/core';
import type { TranslationKey } from '@/frontend/i18n/messages';
import type { ChatGoal } from '@/shared/types/chatGoal';

type Translate = (key: TranslationKey, values?: TranslationValues) => string;

/** One line of a goal, cut at a word-friendly length for notices and the goal bar. */
export function shortGoalText(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Where the goal stands, in a few words (#1225). */
export function chatGoalStateText(goal: ChatGoal, t: Translate, now = Date.now()): string {
  if (goal.state === 'achieved') return t('chat.goal.state.achieved');
  if (goal.state === 'paused') {
    switch (goal.pause?.reason) {
      case 'stopped': return t('chat.goal.state.stopped');
      case 'no_progress': return t('chat.goal.state.noProgress');
      case 'blocked': return t('chat.goal.state.blocked');
      case 'error': return t('chat.goal.state.error');
      default: return t('chat.goal.state.pausedPerson');
    }
  }
  if (goal.retryAt !== undefined && goal.retryAt > now) return t('chat.goal.state.retrying');
  return goal.rounds > 0 ? t('chat.goal.state.active', { round: goal.rounds }) : t('chat.goal.state.starting');
}

/** What the person can do next. */
export function chatGoalHint(goal: ChatGoal, t: Translate): string {
  if (goal.state === 'achieved') return t('chat.goal.hint.achieved');
  if (goal.state === 'paused') return t(goal.pause?.reason === 'person' ? 'chat.goal.hint.resume' : 'chat.goal.hint.message');
  return t('chat.goal.hint.active');
}

/** The goal as notice lines: what it is, where it stands, the agent's last words and what to do. */
export function chatGoalLines(goal: ChatGoal, t: Translate, now = Date.now()): string[] {
  const state = chatGoalStateText(goal, t, now);
  return [
    shortGoalText(goal.text, 500),
    goal.pause?.detail ? `${state}: ${goal.pause.detail}` : state,
    ...(goal.lastNote ? [t('chat.goal.lastNote', { note: goal.lastNote })] : []),
    chatGoalHint(goal, t),
  ];
}
