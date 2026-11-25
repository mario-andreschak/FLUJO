import {
  createChatSlashCommands,
  type ChatSlashActions,
  type ChatSlashContext,
  type ChatSlashServices,
} from '@/frontend/components/Chat/chatSlashCommands';
import { formatNumber, translate, translatePlural } from '@/frontend/i18n/core';
import type { ManualCompactionResponse } from '@/shared/types/contextCompaction';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';

const i18n = {
  t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('en', key, values),
  tp: (key: Parameters<typeof translatePlural>[1], count: number, values?: Parameters<typeof translatePlural>[3]) =>
    translatePlural('en', key, count, values),
  formatNumber: (value: number) => formatNumber('en', value),
};

const flowChat: ChatSlashContext = {
  conversationId: 'conv-1',
  title: 'Release notes',
  flowId: 'flow-1',
  agentName: 'Writer',
  readOnly: false,
  messageCount: 12,
  runState: 'idle',
  nextNodeLabel: 'Draft',
  queuedCount: 0,
  requireApproval: true,
  usage: { promptTokens: 5000, completionTokens: 700 },
  contextInfo: { promptTokens: 3200, contextWindow: 128_000, modelDisplayName: 'Test model' },
};

const personaChat: ChatSlashContext = {
  ...flowChat,
  flowId: null,
  agentName: undefined,
  personaId: 'persona_1',
  personaName: 'Ada',
};

const preview = {
  estimatedTokens: 40_000,
  keepTokens: 19_000,
  summarizedMessages: 9,
  keptRecentMessages: 4,
  keptEarlierUserMessages: 3,
  standingInstructions: 1,
  earlierUserMessagesFit: true,
};

function goal(overrides: Partial<PersonaWorkItem> & { state?: NonNullable<PersonaWorkItem['goal']>['state'] }): PersonaWorkItem {
  const { state = 'active', ...rest } = overrides;
  return {
    schemaVersion: 1, id: 'work_1', personaId: 'persona_1', title: 'Goal', status: 'in_progress',
    priority: 'normal', dependencyIds: [], createdAt: 1, updatedAt: 1,
    goal: {
      successCriteria: 'done', continuationIntervalMs: 60_000, maxConsecutiveFailures: 3, maxRoundsPerDay: 10,
      state, rounds: 0, consecutiveFailures: 0, dailyWindowStartedAt: 0, roundsInWindow: 0,
    },
    ...rest,
  } as PersonaWorkItem;
}

function setup(context: ChatSlashContext, overrides: Partial<ChatSlashServices> = {}) {
  const actions: jest.Mocked<ChatSlashActions> = {
    startNewConversation: jest.fn(async () => undefined),
    forkConversation: jest.fn(async () => 'copy-1'),
  };
  const services: jest.Mocked<ChatSlashServices> = {
    createGoal: jest.fn(async (_personaId, input) => goal({ id: input.id!, title: input.title })),
    getGoal: jest.fn(async () => { throw new Error('missing'); }),
    listGoals: jest.fn(async () => []),
    requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({ status: 'requested', running: false, preview })),
    newId: jest.fn(() => '1234-abcd'),
    ...overrides,
  } as jest.Mocked<ChatSlashServices>;
  return { host: createChatSlashCommands(context, actions, services, i18n), actions, services };
}

describe('chat slash commands (#1225)', () => {
  it('offers goals only to Personas and compaction only to agent chats, and says why', () => {
    const flow = setup(flowChat).host;
    expect(flow.availability('compact')).toEqual({ available: true });
    expect(flow.availability('goal')).toEqual({
      available: false, reason: expect.stringContaining('Goals belong to Personas'),
    });

    const persona = setup(personaChat).host;
    expect(persona.availability('goal')).toEqual({ available: true });
    expect(persona.availability('compact')).toEqual({
      available: false, reason: expect.stringContaining('looks after its own memory'),
    });

    const empty = setup({ ...flowChat, messageCount: 0 }).host;
    expect(empty.availability('compact').available).toBe(false);
    expect(empty.availability('fork').available).toBe(false);

    const archived = setup({ ...personaChat, readOnly: true }).host;
    expect(archived.availability('goal')).toEqual({ available: false, reason: 'This chat is read-only.' });
    expect(archived.availability('new').available).toBe(false);

    const none = setup({ ...flowChat, conversationId: null }).host;
    expect(none.availability('status').available).toBe(false);
    expect(none.availability('help').available).toBe(true);
    expect(none.availability('new').available).toBe(true);
  });

  it('/goal <text> creates an ongoing Persona goal through the Persona API, the same shape as the Persona page', async () => {
    const { host, services } = setup(personaChat);
    const notice = await host.run('goal', 'Keep the docs in sync with every release');
    expect(services.createGoal).toHaveBeenCalledWith('persona_1', {
      id: 'work_1234abcd',
      title: 'Keep the docs in sync with every release',
      priority: 'normal',
      dependencyIds: [],
      goal: {
        successCriteria: 'Keep the docs in sync with every release',
        completionPolicy: 'success_criteria',
        continuationIntervalMs: 60_000,
      },
    });
    expect(notice).toMatchObject({ tone: 'success', title: 'New goal: Keep the docs in sync with every release' });
  });

  it('/goal recovers a goal that was saved although its answer was lost', async () => {
    const lost = Object.assign(new Error('socket hang up'), { status: 502 });
    const { host, services } = setup(personaChat, {
      createGoal: jest.fn(async () => { throw lost; }),
      getGoal: jest.fn(async (_personaId: string, id: string) => goal({ id, title: 'Saved anyway' })),
    });
    const notice = await host.run('goal', 'Saved anyway');
    expect(services.getGoal).toHaveBeenCalledWith('persona_1', 'work_1234abcd');
    expect(notice?.tone).toBe('success');

    const rejected = Object.assign(new Error('Invalid goal'), { status: 400 });
    const refusal = setup(personaChat, { createGoal: jest.fn(async () => { throw rejected; }) });
    expect(await refusal.host.run('goal', 'x')).toMatchObject({ tone: 'error', lines: ['It did not work: Invalid goal'] });
    expect(refusal.services.getGoal).not.toHaveBeenCalled();
  });

  it('/goal alone lists the open goals with their state', async () => {
    const { host } = setup(personaChat, {
      listGoals: jest.fn(async () => [
        goal({ id: 'a', title: 'Old', updatedAt: 1, state: 'paused' }),
        goal({ id: 'b', title: 'Done', updatedAt: 3, state: 'completed' }),
        goal({ id: 'c', title: 'New', updatedAt: 2 }),
        { ...goal({ id: 'd', title: 'Plain task' }), goal: undefined },
      ]),
    });
    const notice = await host.run('goal', '');
    expect(notice?.title).toBe('Goals of this Persona');
    expect(notice?.lines?.slice(0, 2)).toEqual(['New (Ongoing goal)', 'Old (Goal paused)']);
  });

  it('/compact asks the server and confirms what is summarized and what stays', async () => {
    const { host, services } = setup(flowChat);
    const notice = await host.run('compact', '');
    expect(services.requestCompaction).toHaveBeenCalledWith('conv-1');
    expect(notice).toEqual({
      tone: 'success',
      title: 'Summary requested',
      lines: [
        "The AI's next reply uses a summary of older messages.",
        '9 older AI and tool messages are summarized.',
        'The 4 most recent messages stay word for word.',
        'Your 3 earlier messages stay word for word.',
        'Your saved chat stays complete. Only what is sent to the AI gets shorter.',
      ],
    });
  });

  it('/compact names only the guaranteed rules when earlier messages are too long to all stay', async () => {
    const { host } = setup(flowChat, {
      requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({
        status: 'requested', running: true, preview: { ...preview, earlierUserMessagesFit: false, standingInstructions: 2 },
      })),
    });
    const lines = (await host.run('compact', ''))?.lines ?? [];
    expect(lines[0]).toBe('The reply in progress switches to the summary at its next step.');
    expect(lines).toContain('2 earlier messages of yours with rules or corrections stay word for word.');
    expect(lines.some(line => line.startsWith('Your 3 earlier'))).toBe(false);
  });

  it('/compact explains when there is nothing to summarize, when it is switched off and when a Persona owns the chat', async () => {
    const nothing = setup(flowChat, {
      requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({
        status: 'requested', running: false, preview: { ...preview, summarizedMessages: 0, estimatedTokens: 1200 },
      })),
    });
    expect(await nothing.host.run('compact', '')).toMatchObject({ tone: 'info', title: 'Nothing to summarize yet' });

    const off = setup(flowChat, {
      requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({ status: 'disabled', preview })),
    });
    expect(await off.host.run('compact', '')).toMatchObject({
      tone: 'warning', lines: ['Summaries are turned off in Settings, so nothing changed.'],
    });

    const owned = Object.assign(new Error('A Persona manages the memory'), { status: 409, body: { reason: 'persona_owned' } });
    const persona = setup(flowChat, { requestCompaction: jest.fn(async () => { throw owned; }) });
    expect((await persona.host.run('compact', ''))?.lines?.[0]).toContain('looks after its own memory');
  });

  it('/new and /fork use the existing New and Split features', async () => {
    const { host, actions } = setup(flowChat);
    expect(await host.run('new', '')).toBeNull();
    expect(actions.startNewConversation).toHaveBeenCalledTimes(1);

    const forked = await host.run('fork', '');
    expect(actions.forkConversation).toHaveBeenCalledTimes(1);
    expect(forked).toMatchObject({ tone: 'success', conversationId: 'copy-1' });
    expect(forked?.lines?.[0]).toContain('“Release notes”');
  });

  it('/context and /status read the meter and run state already on screen', async () => {
    const { host } = setup({ ...flowChat, runState: 'approval', queuedCount: 2 });
    expect((await host.run('context', ''))?.lines).toEqual([
      'Last request: 3,200 of 128,000 tokens (3%)',
      'AI: Test model',
      'Whole chat so far: 5,000 tokens in, 700 tokens out',
      'Type /compact to summarize older messages.',
    ]);
    expect((await host.run('status', ''))?.lines).toEqual([
      'Now: waiting for your approval',
      'Agent: Writer',
      'Next step: Draft',
      '12 messages in this chat',
      '2 messages wait to be sent',
      'Tools ask for your approval before they run.',
    ]);
  });

  it('/help lists only the commands that work in this chat', async () => {
    const lines = (await setup(flowChat).host.run('help', ''))?.lines ?? [];
    expect(lines.some(line => line.startsWith('/compact — '))).toBe(true);
    expect(lines.some(line => line.startsWith('/goal'))).toBe(false);
    expect(lines.at(-1)).toContain('//goal');
  });

  it('answers an unavailable command with its reason instead of running it', async () => {
    const { host, services } = setup(flowChat);
    expect(await host.run('goal', 'anything')).toMatchObject({ tone: 'warning', title: '/goal' });
    expect(services.createGoal).not.toHaveBeenCalled();
  });
});
