import {
  BIG_TUTORIAL_STEPS,
  BIG_TUTORIAL_STEP_BY_ID,
} from '@/frontend/components/Tour/bigTutorialSteps';
import {
  buildTutorialChatFlow,
  findTutorialChatFlow,
  TUTORIAL_CHAT_PROMPT,
  TUTORIAL_WEB_QUESTION,
} from '@/frontend/components/Tour/bigTutorialFlow';

describe('big tutorial — Stage 1', () => {
  it('uses stable, unique step ids with valid links', () => {
    const ids = BIG_TUTORIAL_STEPS.map(step => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of BIG_TUTORIAL_STEPS) {
      expect(step.path.startsWith('/')).toBe(true);
      expect(step.title).toBeTruthy();
      expect(step.body).toBeTruthy();
      if (step.next) expect(BIG_TUTORIAL_STEP_BY_ID.has(step.next)).toBe(true);
      if (step.back) expect(BIG_TUTORIAL_STEP_BY_ID.has(step.back)).toBe(true);
    }
  });

  it('contains both nested prerequisite tutorials and the return path', () => {
    expect(BIG_TUTORIAL_STEP_BY_ID.get('install-app-intro')?.nested).toBe('install-web-app');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('enable-app')?.nested).toBe('enable-web-app');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('return-to-app-picker')?.next).toBe('return-select-process');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('return-select-process')?.next).toBe('connect-app');
  });

  it('has pause-safe action boundaries around runs, app connection, and save', () => {
    expect(BIG_TUTORIAL_STEP_BY_ID.get('send-first-question')?.next).toBe('wait-for-first-answer');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('connect-app')?.next).toBe('wait-for-app-connection');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('save-agent')?.next).toBe('wait-for-save');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('complete')?.action).toBe('finish');
  });

  it('can restore modal steps and keeps the same tutorial conversation', () => {
    const progress = { status: 'active' as const, stepId: 'choose-chat', conversationId: 'conversation-1' };
    expect(BIG_TUTORIAL_STEP_BY_ID.get('choose-chat')?.onEnter).toBe('open-chat-flow-picker');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('connect-app')?.onEnter).toBe('prepare-app-picker');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('install-app-search')?.onEnter).toBe('open-app-marketplace');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('flow-picker-explain')?.route?.(progress)).toBe('/chat?conversation=conversation-1');
    expect(BIG_TUTORIAL_STEP_BY_ID.get('agents-navigation')?.route?.(progress)).toBe('/chat?conversation=conversation-1');
  });
});

describe('Stage 1 Chat agent bootstrap', () => {
  it('builds the readable Start → Ask AI → Finish agent', () => {
    let id = 0;
    const built = buildTutorialChatFlow('model-1', () => `id-${++id}`);
    expect(built.flow.name).toBe('Chat');
    expect(built.flow.favorite).toBe(true);
    expect(built.flow.nodes.map(node => node.data.type)).toEqual(['start', 'process', 'finish']);
    expect(built.flow.edges.map(edge => [edge.sourceHandle, edge.targetHandle])).toEqual([
      ['start-bottom', 'process-top'],
      ['process-bottom', 'finish-top'],
    ]);
    const process = built.flow.nodes.find(node => node.id === built.processNodeId);
    expect(process?.data.label).toBe('Ask AI');
    expect(process?.data.properties).toMatchObject({
      boundModel: 'model-1',
      promptTemplate: TUTORIAL_CHAT_PROMPT,
      inputMode: 'full-history',
      outputMode: 'latest-message',
    });
    expect(findTutorialChatFlow([built.flow])).toEqual({
      flow: built.flow,
      processNodeId: built.processNodeId,
    });
  });

  it('uses the same current-events question before and after the app is connected', () => {
    expect(TUTORIAL_WEB_QUESTION).toBe('Hey! What happened on the internet today?');
  });
});
