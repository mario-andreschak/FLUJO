import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
import { FlujoChatMessage } from '@/shared/types/chat';

const msg = (id: string, content: string): FlujoChatMessage =>
  ({ id, role: 'assistant', content, timestamp: 1 } as FlujoChatMessage);

describe('upsertMessageById', () => {
  it('appends a new message', () => {
    const messages = [msg('a', 'first')];
    upsertMessageById(messages, msg('b', 'second'));
    expect(messages.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('replaces an existing message in place (idempotent by id)', () => {
    const messages = [msg('a', 'first'), msg('b', 'second')];
    // Same id, updated content (e.g. the end-of-run copy that gains usage).
    upsertMessageById(messages, msg('b', 'second-updated'));
    expect(messages).toHaveLength(2); // no duplicate
    expect(messages[1]).toMatchObject({ id: 'b', content: 'second-updated' });
  });

  it('is a no-op-shaped convergence when called twice with the same message', () => {
    const messages: FlujoChatMessage[] = [];
    const m = msg('x', 'once');
    upsertMessageById(messages, m);
    upsertMessageById(messages, m);
    expect(messages).toHaveLength(1);
  });
});
