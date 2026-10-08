import { collectPinnedConversationIds } from '@/utils/shared/conversationPins';

describe('conversation pin inheritance', () => {
  it('does not inherit pins from a deleted conversation', () => {
    const ids = collectPinnedConversationIds([
      { id: 'child', parentConversationId: 'deleted-parent', rootConversationId: 'deleted-parent' },
    ], ['deleted-parent']);
    expect([...ids]).toEqual([]);
  });

  it('uses the chain root when an intermediate parent is missing', () => {
    const ids = collectPinnedConversationIds([
      { id: 'root' },
      { id: 'child', parentConversationId: 'missing', rootConversationId: 'root' },
      { id: 'other' },
    ], ['root']);
    expect([...ids].sort()).toEqual(['child', 'root']);
  });

  it('terminates on cyclic links and ignores repeated rows', () => {
    const ids = collectPinnedConversationIds([
      { id: 'a', parentConversationId: 'b' },
      { id: 'b', parentConversationId: 'a' },
      { id: 'b', parentConversationId: 'a' },
      { id: 'c', parentConversationId: 'c' },
    ], ['a']);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});
