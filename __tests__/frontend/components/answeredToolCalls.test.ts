import {
  ANSWERED_TOOL_CALLS_KEPT,
  rememberAnsweredToolCall,
  unansweredToolCalls,
} from '@/frontend/components/Chat/answeredToolCalls';

const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } });

describe('answered tool calls never come back as a prompt', () => {
  it('drops calls this page already answered and keeps the others', () => {
    const answered = new Set<string>();
    rememberAnsweredToolCall(answered, 'call-a');
    expect(unansweredToolCalls([call('call-a'), call('call-b')], answered)).toEqual([call('call-b')]);
  });

  it('shows no prompt when every listed call was answered here', () => {
    const answered = new Set(['call-a']);
    expect(unansweredToolCalls([call('call-a')], answered)).toBeNull();
  });

  it('keeps an empty or missing list as it was', () => {
    expect(unansweredToolCalls([], new Set(['call-a']))).toEqual([]);
    expect(unansweredToolCalls(undefined, new Set())).toBeNull();
    expect(unansweredToolCalls(null, new Set())).toBeNull();
  });

  it('remembers only the newest answers, so a long session cannot grow it without end', () => {
    const answered = new Set<string>();
    for (let index = 0; index <= ANSWERED_TOOL_CALLS_KEPT; index += 1) rememberAnsweredToolCall(answered, `call-${index}`);
    expect(answered.size).toBe(ANSWERED_TOOL_CALLS_KEPT);
    expect(answered.has('call-0')).toBe(false);
    expect(answered.has(`call-${ANSWERED_TOOL_CALLS_KEPT}`)).toBe(true);
  });
});
