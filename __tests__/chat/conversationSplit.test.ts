import {
  buildHeadSplitMessages,
  buildSplitMessages,
  buildTailSplitMessages,
} from '@/frontend/components/Chat/conversationSplit';
import type { ChatMessage } from '@/frontend/components/Chat';

// Minimal thread: system, user, assistant(with tool call), tool result, user.
const messages = [
  { id: 'sys', role: 'system', content: 'You are helpful.', timestamp: 1 },
  { id: 'u1', role: 'user', content: 'first', timestamp: 2 },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: 3,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
  },
  { id: 't1', role: 'tool', content: 'result', timestamp: 4, tool_call_id: 'call-1' },
  { id: 'u2', role: 'user', content: 'second', timestamp: 5 },
] as unknown as ChatMessage[];

const ids = (list: ChatMessage[]) => list.map(msg => msg.id);

describe('conversation split slicing', () => {
  it('keeps start -> picked message (inclusive) for a head split', () => {
    expect(ids(buildHeadSplitMessages(messages, 1))).toEqual(['sys', 'u1']);
    expect(ids(buildSplitMessages(messages, 1, 'head'))).toEqual(['sys', 'u1']);
  });

  it('keeps picked message -> end for a tail split', () => {
    expect(ids(buildTailSplitMessages(messages, 4))).toEqual(['sys', 'u2']);
    expect(ids(buildSplitMessages(messages, 4, 'tail'))).toEqual(['sys', 'u2']);
  });

  it('carries the standing system messages of the dropped head', () => {
    expect(ids(buildTailSplitMessages(messages, 2))).toEqual(['sys', 'a1', 't1', 'u2']);
  });

  it('drops a tool result whose assistant call stayed in the head', () => {
    // Cutting at the tool result orphans it — providers reject a result that
    // answers no visible call, so it must not travel into the new conversation.
    expect(ids(buildTailSplitMessages(messages, 3))).toEqual(['sys', 'u2']);
  });

  it('is a lossless partition of the thread when tool pairs are intact', () => {
    const head = buildSplitMessages(messages, 1, 'head');
    const tail = buildSplitMessages(messages, 2, 'tail');
    // 'sys' is intentionally present in both halves; everything else appears once.
    expect([...ids(head), ...ids(tail).filter(id => id !== 'sys')])
      .toEqual(ids(messages));
  });
});
