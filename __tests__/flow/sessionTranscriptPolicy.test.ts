import type { FlujoChatMessage } from '@/shared/types/chat';
import {
  splitLogicalTurns,
  trimCompletedLogicalTurns,
  validateSessionTranscript,
} from '@/backend/execution/flow/sessionTranscriptPolicy';
import { COMPACTION_SUMMARY_MARKER } from '@/backend/execution/flow/handlers/summarizingCompaction';

const message = (
  id: string,
  role: FlujoChatMessage['role'],
  content: string,
  extra: Partial<FlujoChatMessage> = {},
): FlujoChatMessage => ({
  id,
  role,
  content,
  timestamp: 1,
  ...extra,
} as FlujoChatMessage);

describe('Subflow session transcript policy', () => {
  it('counts one user task plus its assistant/tool exchange as one logical turn', () => {
    const messages = [
      message('system', 'system', 'rules'),
      message('u1', 'user', 'task one'),
      message('a1', 'assistant', '', {
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'work', arguments: '{}' } }],
      }),
      message('t1', 'tool', 'done', { tool_call_id: 'call-1' } as Partial<FlujoChatMessage>),
      message('a2', 'assistant', 'finished'),
      message('u2', 'user', 'task two'),
      message('a3', 'assistant', 'finished again'),
    ];

    const split = splitLogicalTurns(messages);
    expect(split.metadata.map((item) => item.id)).toEqual(['system']);
    expect(split.turns.map((turn) => turn.map((item) => item.id))).toEqual([
      ['u1', 'a1', 't1', 'a2'],
      ['u2', 'a3'],
    ]);
  });

  it('keeps metadata and cap - 1 completed turns before the incoming task', () => {
    const messages = [
      message('system', 'system', 'rules'),
      message('summary', 'assistant', `${COMPACTION_SUMMARY_MARKER}\nprior work`),
      message('u1', 'user', 'one'),
      message('a1', 'assistant', 'one done'),
      message('u2', 'user', 'two'),
      message('a2', 'assistant', 'two done'),
      message('u3', 'user', 'three'),
      message('a3', 'assistant', 'three done'),
    ];

    expect(trimCompletedLogicalTurns(messages, 3)).toEqual({
      messages: [messages[0], messages[1], ...messages.slice(4)],
      trimmedTurns: 1,
    });
    expect(trimCompletedLogicalTurns(messages, 1)).toEqual({
      messages: [messages[0], messages[1]],
      trimmedTurns: 3,
    });
  });

  it('rejects corrupt or split assistant tool bundles', () => {
    const valid = [
      message('u', 'user', 'task'),
      message('a', 'assistant', '', {
        tool_calls: [{ id: 'call', type: 'function', function: { name: 'work', arguments: '{}' } }],
      }),
      message('t', 'tool', 'done', { tool_call_id: 'call' } as Partial<FlujoChatMessage>),
    ];
    expect(validateSessionTranscript(valid)).toBeUndefined();
    expect(validateSessionTranscript(valid.slice(0, 2))).toContain('missing result');
    expect(validateSessionTranscript([valid[0], valid[2]])).toContain('does not match');
  });
});
