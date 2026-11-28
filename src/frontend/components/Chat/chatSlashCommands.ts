import type { TranslationValues } from '@/frontend/i18n/core';
import type { PluralTranslationKey, TranslationKey } from '@/frontend/i18n/messages';
import type { ManualCompactionResponse } from '@/shared/types/contextCompaction';
import { CHAT_GOAL_TEXT_LIMIT, type ChatGoal, type ChatGoalAction, type ChatGoalUpdate } from '@/shared/types/chatGoal';
import type { CreatePersonaWorkItemInput, PersonaGoalLifecycleState, PersonaWorkItem } from '@/shared/types/enduringAgent';
import type { ConversationContextInfo } from '@/shared/types/model/contextUsage';
import { chatGoalLines, shortGoalText } from './chatGoalText';
import {
  SLASH_COMMANDS,
  type SlashCommandAvailability,
  type SlashCommandHost,
  type SlashCommandId,
  type SlashCommandNotice,
} from './slashCommands';

export type ChatRunState = 'idle' | 'loading' | 'running' | 'approval' | 'debugger';

/** What the commands may read about the chat on screen. */
export interface ChatSlashContext {
  conversationId: string | null;
  title?: string;
  flowId?: string | null;
  agentName?: string;
  personaId?: string;
  personaName?: string;
  /** An anonymized Persona archive, which nobody may change. */
  readOnly: boolean;
  /** Messages in the whole chat, including ones not loaded on screen yet. */
  messageCount: number;
  runState: ChatRunState;
  nextNodeLabel?: string;
  queuedCount: number;
  requireApproval: boolean;
  usage?: { promptTokens: number; completionTokens: number };
  contextInfo?: ConversationContextInfo;
}

/** Existing chat page features the commands call. */
export interface ChatSlashActions {
  /** Same agent or Persona as the chat on screen, like the "New" button. */
  startNewConversation: () => Promise<void> | void;
  /** Copy the whole chat into a new one, like "Split here" on the last message. Returns the new chat's id. */
  forkConversation: () => Promise<string | null> | string | null;
  /** The chat's goal changed, so the goal bar shows it right away. */
  goalChanged?: () => void;
}

/** Existing APIs, with their own permission checks. */
export interface ChatSlashServices {
  createGoal: (personaId: string, input: Omit<CreatePersonaWorkItemInput, 'personaId'>) => Promise<PersonaWorkItem>;
  getGoal: (personaId: string, workItemId: string) => Promise<PersonaWorkItem>;
  listGoals: (personaId: string) => Promise<PersonaWorkItem[]>;
  requestCompaction: (conversationId: string) => Promise<ManualCompactionResponse>;
  getChatGoal: (conversationId: string) => Promise<ChatGoal | null>;
  setChatGoal: (conversationId: string, text: string) => Promise<ChatGoalUpdate>;
  updateChatGoal: (conversationId: string, action: ChatGoalAction) => Promise<ChatGoalUpdate>;
  clearChatGoal: (conversationId: string) => Promise<ChatGoal | null>;
  newId: () => string;
}

export interface ChatSlashI18n {
  t: (key: TranslationKey, values?: TranslationValues) => string;
  tp: (key: PluralTranslationKey, count: number, values?: TranslationValues) => string;
  formatNumber: (value: number) => string;
}

const GOAL_TITLE_LIMIT = 500;
const GOALS_SHOWN = 5;
/** Same pace the Persona page proposes for a new ongoing goal. */
const GOAL_INTERVAL_MS = 60_000;
const OPEN_GOAL_STATES: ReadonlySet<PersonaGoalLifecycleState> = new Set(['active', 'paused', 'needs_input']);
/** Words after "/goal" that remove the chat's goal, like Claude Code's `/goal clear`. */
const GOAL_CLEAR_WORDS: ReadonlySet<string> = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);
const GOAL_CONTROL_WORDS: ReadonlySet<string> = new Set([...GOAL_CLEAR_WORDS, 'pause', 'resume']);

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  return typeof status === 'number' ? status : undefined;
}

function errorReason(error: unknown): string | undefined {
  const body = error && typeof error === 'object' && 'body' in error ? error.body : undefined;
  const reason = body && typeof body === 'object' && 'reason' in body ? body.reason : undefined;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * The chat's slash commands, built from existing features only: Persona goals,
 * the compaction request, "New", "Split here", the context meter and run state.
 */
export function createChatSlashCommands(
  context: ChatSlashContext,
  actions: ChatSlashActions,
  services: ChatSlashServices,
  { t, tp, formatNumber }: ChatSlashI18n,
): SlashCommandHost {
  const unavailable = (key: TranslationKey): SlashCommandAvailability => ({ available: false, reason: t(key) });
  const ok: SlashCommandAvailability = { available: true };

  const availability = (id: SlashCommandId): SlashCommandAvailability => {
    switch (id) {
      case 'help':
        return ok;
      case 'new':
        return context.personaId && context.readOnly ? unavailable('chat.slash.unavailable.readOnly') : ok;
      case 'status':
      case 'context':
        return context.conversationId ? ok : unavailable('chat.slash.unavailable.noConversation');
      case 'fork':
        if (!context.conversationId) return unavailable('chat.slash.unavailable.noConversation');
        if (context.readOnly) return unavailable('chat.slash.unavailable.readOnly');
        return context.messageCount > 0 ? ok : unavailable('chat.slash.unavailable.forkEmpty');
      case 'goal':
        if (!context.personaId && !context.conversationId) return unavailable('chat.slash.unavailable.noConversation');
        return context.readOnly ? unavailable('chat.slash.unavailable.readOnly') : ok;
      case 'compact':
        if (!context.conversationId) return unavailable('chat.slash.unavailable.noConversation');
        if (context.personaId) return unavailable('chat.slash.unavailable.compactPersona');
        return context.messageCount > 0 ? ok : unavailable('chat.slash.unavailable.compactEmpty');
    }
  };

  const help = (): SlashCommandNotice => ({
    tone: 'info',
    title: t('chat.slash.help.title'),
    lines: [
      ...SLASH_COMMANDS.filter(command => availability(command.id).available).map(command =>
        `/${command.name}${command.argsHint ? ` ${t(command.argsHint)}` : ''} — ${t(command.description)}`),
      t('chat.slash.help.literal'),
    ],
  });

  const contextNotice = (): SlashCommandNotice => {
    const info = context.contextInfo;
    const used = info?.totalTokens ?? info?.promptTokens;
    const lines: string[] = [];
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) {
      lines.push(info?.contextWindow && info.contextWindow > 0
        ? t('chat.slash.context.used', {
          used: formatNumber(used),
          total: formatNumber(info.contextWindow),
          percent: Math.round((used / info.contextWindow) * 100),
        })
        : t('chat.slash.context.usedNoWindow', { used: formatNumber(used) }));
    } else {
      lines.push(t('chat.slash.context.unknown'));
    }
    if (info?.modelDisplayName) lines.push(t('chat.slash.context.model', { model: info.modelDisplayName }));
    if (context.usage) {
      lines.push(t('chat.slash.context.totals', {
        input: formatNumber(context.usage.promptTokens),
        output: formatNumber(context.usage.completionTokens),
      }));
    }
    if (availability('compact').available) lines.push(t('chat.slash.context.tip'));
    return { tone: 'info', title: t('chat.slash.context.title'), lines };
  };

  const statusNotice = (): SlashCommandNotice => {
    const lines = [t('chat.slash.status.state', { state: t(`chat.slash.status.${context.runState}`) })];
    if (context.personaId) {
      lines.push(t('chat.slash.status.persona', { name: context.personaName || context.personaId }));
    } else if (context.agentName) {
      lines.push(t('chat.slash.status.agent', { name: context.agentName }));
    }
    if (context.nextNodeLabel) lines.push(t('chat.slash.status.node', { node: context.nextNodeLabel }));
    lines.push(tp('chat.slash.status.messages', context.messageCount, { count: formatNumber(context.messageCount) }));
    if (context.queuedCount > 0) {
      lines.push(tp('chat.slash.status.queued', context.queuedCount, { count: formatNumber(context.queuedCount) }));
    }
    if (!context.personaId) {
      lines.push(t(context.requireApproval ? 'chat.slash.status.approvalOn' : 'chat.slash.status.approvalOff'));
    }
    return { tone: 'info', title: t('chat.slash.status.title'), lines };
  };

  const listGoals = async (personaId: string): Promise<SlashCommandNotice> => {
    const goals = (await services.listGoals(personaId))
      .filter(item => item.goal && OPEN_GOAL_STATES.has(item.goal.state))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (goals.length === 0) {
      return { tone: 'info', title: t('chat.slash.goal.listTitle'), lines: [t('chat.slash.goal.none')] };
    }
    const lines = goals.slice(0, GOALS_SHOWN).map(item =>
      t('chat.slash.goal.item', { title: item.title, state: t(`personas.goal.${item.goal!.state}`) }));
    if (goals.length > GOALS_SHOWN) {
      const more = goals.length - GOALS_SHOWN;
      lines.push(tp('chat.slash.goal.more', more, { count: formatNumber(more) }));
    }
    lines.push(t('chat.slash.goal.manage'));
    return { tone: 'info', title: t('chat.slash.goal.listTitle'), lines };
  };

  const createGoal = async (personaId: string, text: string): Promise<SlashCommandNotice> => {
    const title = text.length > GOAL_TITLE_LIMIT ? `${text.slice(0, GOAL_TITLE_LIMIT - 1)}…` : text;
    const id = `work_${services.newId().replaceAll('-', '')}`;
    const input: Omit<CreatePersonaWorkItemInput, 'personaId'> = {
      id,
      title,
      ...(title !== text ? { description: text } : {}),
      priority: 'normal',
      dependencyIds: [],
      goal: { successCriteria: text, completionPolicy: 'success_criteria', continuationIntervalMs: GOAL_INTERVAL_MS },
    };
    let created: PersonaWorkItem;
    try {
      created = await services.createGoal(personaId, input);
    } catch (error) {
      // A lost answer can hide a saved goal. The caller-chosen id tells which.
      const status = errorStatus(error);
      if (status !== undefined && status >= 400 && status < 500 && status !== 409) throw error;
      created = await services.getGoal(personaId, id).catch(() => { throw error; });
    }
    return {
      tone: 'success',
      title: t('chat.slash.goal.created', { title: created.title }),
      lines: [t('personas.goal.owned'), t('chat.slash.goal.manage')],
    };
  };

  const chatGoalStatus = (goal: ChatGoal | null): SlashCommandNotice => goal
    ? { tone: 'info', title: t('chat.slash.goal.statusTitle'), lines: chatGoalLines(goal, t) }
    : { tone: 'info', title: t('chat.slash.goal.statusTitle'), lines: [t('chat.slash.goal.noneChat')] };

  /** "/goal" in a chat with an agent: set, show, pause, resume or clear the chat's one goal. */
  const chatGoal = async (conversationId: string, args: string): Promise<SlashCommandNotice> => {
    const word = args.toLowerCase();
    try {
      if (!args) return chatGoalStatus(await services.getChatGoal(conversationId));
      if (word === 'pause' || word === 'resume') {
        const { goal, running } = await services.updateChatGoal(conversationId, word);
        actions.goalChanged?.();
        if (!goal) return chatGoalStatus(null);
        if (word === 'pause') {
          return goal.state === 'paused' && goal.pause?.reason === 'person'
            ? { tone: 'info', title: '/goal', lines: [t('chat.slash.goal.paused')] }
            : chatGoalStatus(goal);
        }
        return goal.state === 'active'
          ? { tone: 'success', title: '/goal', lines: [t(running ? 'chat.slash.goal.resumedAfterReply' : 'chat.slash.goal.resumed')] }
          : chatGoalStatus(goal);
      }
      if (GOAL_CLEAR_WORDS.has(word)) {
        const removed = await services.clearChatGoal(conversationId);
        actions.goalChanged?.();
        return removed
          ? { tone: 'success', title: t('chat.slash.goal.cleared', { text: shortGoalText(removed.text) }) }
          : chatGoalStatus(null);
      }
      if (args.length > CHAT_GOAL_TEXT_LIMIT) {
        return { tone: 'warning', title: '/goal', lines: [t('chat.slash.goal.tooLong', { limit: formatNumber(CHAT_GOAL_TEXT_LIMIT) })] };
      }
      const { goal, running } = await services.setChatGoal(conversationId, args);
      actions.goalChanged?.();
      return {
        tone: 'success',
        title: t('chat.slash.goal.set', { text: shortGoalText(goal?.text ?? args) }),
        lines: [t(running ? 'chat.slash.goal.afterReply' : 'chat.slash.goal.startsNow'), t('chat.slash.goal.howTo')],
      };
    } catch (error) {
      const reason = errorReason(error);
      if (reason === 'no_goal') return chatGoalStatus(null);
      if (reason === 'not_found') return { tone: 'warning', title: '/goal', lines: [t('chat.slash.goal.notSaved')] };
      if (reason === 'read_only' || reason === 'protected') {
        return { tone: 'warning', title: '/goal', lines: [t('chat.slash.unavailable.readOnly')] };
      }
      throw error;
    }
  };

  const compact = async (conversationId: string): Promise<SlashCommandNotice> => {
    let answer: ManualCompactionResponse;
    try {
      answer = await services.requestCompaction(conversationId);
    } catch (error) {
      const reason = errorReason(error);
      if (reason === 'persona_owned') return { tone: 'warning', title: '/compact', lines: [t('chat.slash.unavailable.compactPersona')] };
      if (reason === 'read_only' || reason === 'protected') {
        return { tone: 'warning', title: '/compact', lines: [t('chat.slash.unavailable.readOnly')] };
      }
      throw error;
    }
    const { preview } = answer;
    if (preview.summarizedMessages === 0) {
      return {
        tone: 'info',
        title: t('chat.slash.compact.nothingTitle'),
        lines: [t('chat.slash.compact.nothing', {
          tokens: formatNumber(preview.estimatedTokens),
          keep: formatNumber(preview.keepTokens),
        })],
      };
    }
    const lines = [
      t(answer.running ? 'chat.slash.compact.running' : 'chat.slash.compact.nextReply'),
      tp('chat.slash.compact.summarized', preview.summarizedMessages, { count: formatNumber(preview.summarizedMessages) }),
      tp('chat.slash.compact.keptRecent', preview.keptRecentMessages, { count: formatNumber(preview.keptRecentMessages) }),
    ];
    if (preview.earlierUserMessagesFit && preview.keptEarlierUserMessages > 0) {
      lines.push(tp('chat.slash.compact.keptUser', preview.keptEarlierUserMessages, {
        count: formatNumber(preview.keptEarlierUserMessages),
      }));
    } else if (!preview.earlierUserMessagesFit && preview.standingInstructions > 0) {
      lines.push(tp('chat.slash.compact.keptRules', preview.standingInstructions, {
        count: formatNumber(preview.standingInstructions),
      }));
    }
    lines.push(t('chat.slash.compact.historyKept'));
    return { tone: 'success', title: t('chat.slash.compact.title'), lines };
  };

  const run = async (id: SlashCommandId, args: string): Promise<SlashCommandNotice | null> => {
    const allowed = availability(id);
    if (!allowed.available) return { tone: 'warning', title: `/${id}`, lines: [allowed.reason] };
    try {
      switch (id) {
        case 'help':
          return help();
        case 'new':
          await actions.startNewConversation();
          return null;
        case 'fork': {
          const copyId = await actions.forkConversation();
          if (!copyId) return { tone: 'warning', title: '/fork', lines: [t('chat.slash.unavailable.forkEmpty')] };
          return {
            tone: 'success',
            title: '/fork',
            lines: [t('chat.slash.fork.done', { title: context.title || t('chat.page.untitled') })],
            conversationId: copyId,
          };
        }
        case 'context':
          return contextNotice();
        case 'status':
          return statusNotice();
        case 'goal':
          if (!context.personaId) return await chatGoal(context.conversationId!, args);
          // A Persona's goals are managed on its page; control words never become a goal.
          if (GOAL_CONTROL_WORDS.has(args.toLowerCase())) return { tone: 'info', title: '/goal', lines: [t('chat.slash.goal.manage')] };
          return args ? await createGoal(context.personaId, args) : await listGoals(context.personaId);
        case 'compact':
          return await compact(context.conversationId!);
      }
    } catch (error) {
      return { tone: 'error', title: `/${id}`, lines: [t('chat.slash.failed', { error: errorText(error) })] };
    }
  };

  return { availability, run };
}
