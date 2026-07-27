/**
 * Issue #258 — the synthetic `question` tool that lets a model ask the user a
 * structured multiple-choice question mid-run and keep working with the answer.
 *
 * Pins:
 *  - buildQuestionTool exposes the deterministic definition with opencode's
 *    guidance (no self-authored "Other"; recommended-first; auto free-text);
 *  - executeQuestionTool emits `run:awaiting_question`, blocks on the registry,
 *    and resolves with the formatted prose when answered (single + multi + custom);
 *  - decline halts cleanly (declined flag, not a tool error);
 *  - unattended / missing conversation degrade to a clear tool-error, never a
 *    silent stall.
 */

import {
  buildQuestionTool,
  executeQuestionTool,
  isQuestionToolName,
  formatAnswers,
  QUESTION_TOOL_NAME,
  CUSTOM_OPTION_LABEL,
} from '@/backend/execution/flow/handlers/runQuestionTool';
import {
  resolvePendingQuestion,
  declinePendingQuestion,
  listAllPendingQuestions,
  clearPendingQuestions,
} from '@/backend/services/questionRegistry';
import type { RawExecutionEvent } from '@/shared/types/execution/events';

/** Grab the questionId from the emitted run:awaiting_question event. */
function emittedQuestionId(emit: jest.Mock): string {
  const call = emit.mock.calls.find((c) => (c[0] as RawExecutionEvent).type === 'run:awaiting_question');
  if (!call) throw new Error('run:awaiting_question was not emitted');
  return (call[0] as { questionId: string }).questionId;
}

describe('buildQuestionTool', () => {
  it('exposes a deterministic `question` tool with the required guidance', () => {
    const tool = buildQuestionTool();
    expect(tool.name).toBe(QUESTION_TOOL_NAME);
    expect(isQuestionToolName(tool.name)).toBe(true);
    expect(isQuestionToolName('something_else')).toBe(false);
    // opencode guidance carried verbatim so the model behaves the same.
    const desc = tool.description ?? '';
    expect(desc).toContain('(Recommended)');
    expect(desc).toContain(CUSTOM_OPTION_LABEL);
    expect(desc.toLowerCase()).toContain('other');
    // Schema shape.
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props.questions).toBeDefined();
    expect(tool.inputSchema.required).toContain('questions');
  });

  it('is byte-identical across calls (prefix-cache stability)', () => {
    expect(JSON.stringify(buildQuestionTool())).toBe(JSON.stringify(buildQuestionTool()));
  });
});

describe('executeQuestionTool — guards', () => {
  it('refuses when there is no conversation to scope the question to', async () => {
    const outcome = await executeQuestionTool(
      { questions: [{ prompt: 'x', options: ['a'] }] },
      {},
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/not available/i);
  });

  it('degrades to a clear tool-error in an unattended run (no silent stall)', async () => {
    const emit = jest.fn();
    const outcome = await executeQuestionTool(
      { questions: [{ prompt: 'x', options: ['a'] }] },
      { conversationId: 'c1', emit, unattended: true },
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/unattended/i);
    // Must not have blocked / emitted an awaiting event.
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'run:awaiting_question' }));
  });

  it('rejects an empty questions array', async () => {
    const outcome = await executeQuestionTool({ questions: [] }, { conversationId: 'c1' });
    expect(outcome.success).toBe(false);
  });
});

describe('executeQuestionTool — interactive resolve', () => {
  afterEach(() => {
    clearPendingQuestions('conv-q');
  });

  it('emits run:awaiting_question, auto-appends the custom option, and resolves with prose', async () => {
    const emit = jest.fn();
    const pending = executeQuestionTool(
      { questions: [{ prompt: 'Pick a color', options: ['Red', 'Blue'] }] },
      { conversationId: 'conv-q', emit },
    );

    // Event emitted synchronously before the await.
    const evt = emit.mock.calls.find((c) => (c[0] as RawExecutionEvent).type === 'run:awaiting_question')![0] as {
      questionId: string;
      questions: Array<{ options: string[]; custom?: boolean }>;
    };
    // custom defaults ON → the free-text option is appended.
    expect(evt.questions[0].options).toEqual(['Red', 'Blue', CUSTOM_OPTION_LABEL]);

    // Registry has the pending question exposed to the headless inbox.
    expect(listAllPendingQuestions().some((q) => q.questionId === evt.questionId)).toBe(true);

    expect(resolvePendingQuestion('conv-q', evt.questionId, [['Blue']])).toBe(true);
    const outcome = await pending;
    expect(outcome.success).toBe(true);
    expect(String(outcome.data)).toContain('Pick a color');
    expect(String(outcome.data)).toContain('Blue');
  });

  it('does not append the custom option when custom:false', async () => {
    const emit = jest.fn();
    const pending = executeQuestionTool(
      { questions: [{ prompt: 'q', options: ['a', 'b'], custom: false }] },
      { conversationId: 'conv-q', emit },
    );
    const evt = emit.mock.calls.find((c) => (c[0] as RawExecutionEvent).type === 'run:awaiting_question')![0] as {
      questionId: string;
      questions: Array<{ options: string[] }>;
    };
    expect(evt.questions[0].options).toEqual(['a', 'b']);
    resolvePendingQuestion('conv-q', evt.questionId, [['a']]);
    await pending;
  });

  it('serializes multi-select and free-text answers into the prose', async () => {
    const emit = jest.fn();
    const pending = executeQuestionTool(
      {
        questions: [
          { prompt: 'Toppings?', options: ['Cheese', 'Ham'], multiple: true },
          { prompt: 'Anything else?', options: [] },
        ],
      },
      { conversationId: 'conv-q', emit },
    );
    const qid = emittedQuestionId(emit);
    // q0: two picks; q1: a free-text answer (the custom option's typed value).
    resolvePendingQuestion('conv-q', qid, [['Cheese', 'Ham'], ['extra crispy']]);
    const outcome = await pending;
    expect(outcome.success).toBe(true);
    expect(String(outcome.data)).toContain('Cheese, Ham');
    expect(String(outcome.data)).toContain('extra crispy');
  });

  it('halts cleanly on decline (declined flag, not a tool error)', async () => {
    const emit = jest.fn();
    const pending = executeQuestionTool(
      { questions: [{ prompt: 'q', options: ['a'] }] },
      { conversationId: 'conv-q', emit },
    );
    const qid = emittedQuestionId(emit);
    expect(declinePendingQuestion('conv-q', qid)).toBe(true);
    const outcome = await pending;
    expect(outcome.success).toBe(true);
    expect(outcome.declined).toBe(true);
    expect(String(outcome.data)).toMatch(/declined/i);
  });

  it('returns a tool-error on timeout rather than hanging forever', async () => {
    const emit = jest.fn();
    const outcome = await executeQuestionTool(
      { questions: [{ prompt: 'q', options: ['a'] }] },
      { conversationId: 'conv-q', emit, timeoutMs: 5 },
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/no answer/i);
  });
});

describe('formatAnswers', () => {
  it('joins multiple selections and keeps question order', () => {
    const prose = formatAnswers(
      [
        { prompt: 'A?', options: [] },
        { prompt: 'B?', options: [] },
      ],
      [['one', 'two'], ['three']],
    );
    expect(prose).toContain('"A?" = "one, two"');
    expect(prose).toContain('"B?" = "three"');
    expect(prose).toMatch(/continue with the user's answers/i);
  });
});
