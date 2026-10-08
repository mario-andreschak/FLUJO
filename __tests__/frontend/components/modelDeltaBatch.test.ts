import { applyModelDeltaBatch } from '@/frontend/components/Chat/modelDeltaBatch';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelDeltaEvent } from '@/shared/types/execution/events';

const delta = (
  seq: number,
  patch: Partial<ModelDeltaEvent>,
): ModelDeltaEvent => ({
  type: 'model:delta',
  conversationId: 'conversation-1',
  messageId: 'assistant-1',
  seq,
  timestamp: 1_000 + seq,
  ...patch,
});

describe('applyModelDeltaBatch', () => {
  it('folds text, tool arguments, and media into one transcript update', () => {
    const conversation = {
      id: 'conversation-1',
      messages: [] as FlujoChatMessage[],
    };
    const mediaPart = { type: 'image' as const, url: 'data:image/png;base64,abc' };

    const next = applyModelDeltaBatch(conversation, [
      delta(1, { delta: 'Hello ' }),
      delta(2, {
        delta: 'world',
        toolCallDelta: { index: 0, id: 'call-1', nameDelta: 'search', argumentsDelta: '{"q":' },
      }),
      delta(3, {
        toolCallDelta: { index: 0, argumentsDelta: '"flujo"}' },
        mediaPart,
      }),
      delta(4, { mediaPart }),
    ]);

    expect(next).not.toBe(conversation);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hello world',
      tool_calls: [{
        id: 'call-1',
        function: { name: 'search', arguments: '{"q":"flujo"}' },
      }],
      media: [mediaPart],
    });
  });

  it('preserves identity when no delta belongs to the conversation', () => {
    const conversation = {
      id: 'conversation-1',
      messages: [] as FlujoChatMessage[],
    };

    expect(applyModelDeltaBatch(conversation, [
      delta(1, { conversationId: 'conversation-2', delta: 'ignored' }),
    ])).toBe(conversation);
  });
});
