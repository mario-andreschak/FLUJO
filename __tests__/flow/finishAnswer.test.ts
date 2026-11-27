/** #1419: the rules that decide whether a hand-off to Finish came without an answer. */
import type { FlujoChatMessage } from '@/shared/types/chat';
import { answerFromHandoffArguments, lacksFinishAnswer, latestTurnHasNoAnswer, markNoAnswer } from '@/backend/execution/flow/finishAnswer';

const call = (args: string) => ({ id: 'call_1', type: 'function' as const, function: { name: 'handoff_to_finish_node', arguments: args } });
const message = (fields: Partial<FlujoChatMessage>): FlujoChatMessage =>
  ({ id: `m${Math.random()}`, timestamp: 1, role: 'assistant', content: '', ...fields }) as FlujoChatMessage;

describe('answerFromHandoffArguments', () => {
  it('takes answer text the model put into the hand-off call', () => {
    expect(answerFromHandoffArguments([call('{"answer":"  Open 8 to 18. "}')])).toBe('Open 8 to 18.');
    expect(answerFromHandoffArguments([call('{}'), call('{"message":"Open 8 to 18."}')])).toBe('Open 8 to 18.');
  });

  it('ignores calls without answer text, other arguments and broken JSON', () => {
    expect(answerFromHandoffArguments([call('{}')])).toBeUndefined();
    expect(answerFromHandoffArguments([call('{"status":"done"}')])).toBeUndefined();
    expect(answerFromHandoffArguments([call('{"answer":"   "}')])).toBeUndefined();
    expect(answerFromHandoffArguments([call('{"answer":')])).toBeUndefined();
    expect(answerFromHandoffArguments([call('["Open 8 to 18."]')])).toBeUndefined();
  });
});

describe('lacksFinishAnswer', () => {
  const user = message({ role: 'user', content: 'When are you open?' });
  const handoff = message({ content: null, tool_calls: [call('{}')] });

  it('is true when neither the reply nor the hand-off turn has text', () => {
    expect(lacksFinishAnswer('', handoff, [user, handoff])).toBe(true);
    expect(lacksFinishAnswer(undefined, handoff, [user, handoff])).toBe(true);
    expect(lacksFinishAnswer('  \n', undefined, [user])).toBe(true);
  });

  it('is false when the reply or the hand-off turn has text', () => {
    expect(lacksFinishAnswer('Open 8 to 18.', handoff, [user, handoff])).toBe(false);
    const spoken = message({ content: 'Open 8 to 18.', tool_calls: [call('{}')] });
    expect(lacksFinishAnswer('', spoken, [user, spoken])).toBe(false);
  });

  it('is false when the model produced media since the person asked, and ignores older turns', () => {
    const picture = message({ media: [{ type: 'image', url: 'flujo://run/image/1' }] });
    expect(lacksFinishAnswer('', handoff, [user, picture, handoff])).toBe(false);
    expect(lacksFinishAnswer('', handoff, [picture, user, handoff])).toBe(true);
  });
});

describe('markNoAnswer and latestTurnHasNoAnswer', () => {
  it('marks the step\'s empty reply of the latest turn only', () => {
    const user = message({ role: 'user', content: 'When are you open?' });
    const handoff = message({ content: null, tool_calls: [call('{}')], processNodeId: 'process' });
    const silent = message({ content: '', processNodeId: 'process' });
    const messages = [user, handoff, silent];

    expect(latestTurnHasNoAnswer(messages)).toBe(false);
    markNoAnswer(messages, 'process');
    expect(silent.noAnswer).toBe(true);
    expect(handoff.noAnswer).toBeUndefined();
    expect(latestTurnHasNoAnswer(messages)).toBe(true);
    expect(latestTurnHasNoAnswer([...messages, message({ role: 'user', content: 'Hello?' })])).toBe(false);
  });

  it('never marks a reply that has text, or one from another step', () => {
    const answered = message({ content: 'Open 8 to 18.', processNodeId: 'process' });
    markNoAnswer([answered], 'process');
    expect(answered.noAnswer).toBeUndefined();
    const other = message({ content: '', processNodeId: 'other' });
    markNoAnswer([other], 'process');
    expect(other.noAnswer).toBeUndefined();
  });
});
