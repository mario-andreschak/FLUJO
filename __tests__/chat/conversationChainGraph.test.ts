/**
 * Pure-unit tests for the Chain Chat building blocks:
 *  - the active-status allowlist,
 *  - latest user/assistant/tool preview extraction,
 *  - the semantic top-down hierarchy adapter.
 */
import {
  ACTIVE_CONVERSATION_STATUSES,
  isActiveConversationStatus,
} from '@/utils/shared/conversationActivity';
import {
  extractLatestDisplayableMessage,
  extractMessageText,
} from '@/utils/shared/conversationPreview';
import {
  buildConversationChainTree,
  chainBranchIsActive,
  type ConversationChainTreeNode,
} from '@/utils/shared/conversationChainTree';
import type { ConversationChainNode } from '@/shared/types/conversationChain';

const node = (
  id: string,
  overrides: Partial<ConversationChainNode> = {},
): ConversationChainNode => ({
  id,
  title: id,
  active: false,
  createdAt: 1,
  updatedAt: 1,
  parentConversationId: null,
  rootConversationId: null,
  lastMessage: null,
  ...overrides,
});

function flatten(roots: ConversationChainTreeNode[]): ConversationChainTreeNode[] {
  return roots.flatMap((root) => [root, ...flatten(root.children)]);
}

describe('active conversation status allowlist', () => {
  it('only treats in-flight statuses as active', () => {
    expect([...ACTIVE_CONVERSATION_STATUSES]).toEqual([
      'running',
      'awaiting_tool_approval',
      'paused_debug',
    ]);
    for (const status of ACTIVE_CONVERSATION_STATUSES) {
      expect(isActiveConversationStatus(status)).toBe(true);
    }
    for (const status of ['completed', 'error', 'capped', 'unknown', '']) {
      expect(isActiveConversationStatus(status)).toBe(false);
    }
    expect(isActiveConversationStatus(undefined)).toBe(false);
    expect(isActiveConversationStatus(null)).toBe(false);
  });
});

describe('latest displayable activity extraction', () => {
  it('flattens string and multimodal text content', () => {
    expect(extractMessageText('  hello  ')).toBe('hello');
    expect(
      extractMessageText([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'https://example.test/x.png' } },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a b');
    expect(extractMessageText(undefined)).toBe('');
    expect(extractMessageText({ nope: true })).toBe('');
  });

  it('picks the newest visible user or assistant message and skips system plumbing', () => {
    const preview = extractLatestDisplayableMessage([
      { role: 'user', content: 'older', timestamp: 1 },
      { role: 'assistant', content: '', timestamp: 2 },
      { role: 'assistant', content: 'the\n\nanswer', timestamp: 4 },
      { role: 'system', content: 'system prompt', timestamp: 5 },
    ]);
    expect(preview).toEqual({ role: 'assistant', text: 'the answer', timestamp: 4, truncated: false });
  });

  it('projects the latest tool result with its matching function name', () => {
    const preview = extractLatestDisplayableMessage([
      {
        role: 'assistant',
        content: 'I will inspect it.',
        timestamp: 1,
        tool_calls: [{ id: 'call-1', function: { name: 'read_file' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'file contents', timestamp: 2 },
    ]);

    expect(preview).toEqual({
      role: 'tool',
      text: 'read_file',
      toolName: 'read_file',
      toolKind: 'result',
      timestamp: 2,
      truncated: false,
    });
  });

  it('turns an assistant tool-call-only turn into compact tool activity', () => {
    const preview = extractLatestDisplayableMessage([
      {
        role: 'assistant',
        content: '',
        timestamp: 7,
        tool_calls: [
          { id: 'call-1', function: { name: 'search_files' } },
          { id: 'call-2', function: { name: 'read_file' } },
        ],
      },
    ]);

    expect(preview).toEqual({
      role: 'tool',
      text: 'search_files · read_file',
      toolKind: 'call',
      timestamp: 7,
      truncated: false,
    });
  });

  it('skips disabled messages and bounds the selected preview', () => {
    const preview = extractLatestDisplayableMessage([
      { role: 'assistant', content: 'kept', timestamp: 1 },
      { role: 'tool', content: 'reverted', timestamp: 2, disabled: true },
      { role: 'user', content: 'x'.repeat(50), timestamp: 3 },
    ], 10);

    expect(preview).toMatchObject({ role: 'user', truncated: true });
    expect(preview?.text).toHaveLength(10);
    expect(extractLatestDisplayableMessage([])).toBeNull();
    expect(extractLatestDisplayableMessage(undefined)).toBeNull();
    expect(extractLatestDisplayableMessage([null, 42, { role: 'system', content: 'x' }])).toBeNull();
  });
});

describe('semantic conversation-chain tree adapter', () => {
  it('returns an empty forest for empty input', () => {
    expect(buildConversationChainTree([])).toEqual({ roots: [], detachedIds: [] });
  });

  it('builds a deterministic parent-to-child hierarchy with semantic depths', () => {
    const input = [
      node('root'),
      node('a', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('b', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('a1', { parentConversationId: 'a', rootConversationId: 'root' }),
    ];
    const model = buildConversationChainTree(input);
    const all = flatten(model.roots);

    expect(model.roots.map((root) => root.id)).toEqual(['root']);
    expect(model.roots[0].children.map((child) => child.id)).toEqual(['a', 'b']);
    expect(model.roots[0].children[0].children.map((child) => child.id)).toEqual(['a1']);
    expect(all.map((entry) => [entry.id, entry.depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['a1', 2],
      ['b', 1],
    ]);
    expect(buildConversationChainTree(input)).toEqual(model);
  });

  it('reattaches a missing-parent node to its loaded root and marks it detached', () => {
    const model = buildConversationChainTree([
      node('root'),
      node('orphan', { parentConversationId: 'gone', rootConversationId: 'root' }),
    ]);

    expect(model.roots.map((root) => root.id)).toEqual(['root']);
    expect(model.roots[0].children.map((child) => child.id)).toEqual(['orphan']);
    expect(model.roots[0].children[0]).toMatchObject({ depth: 1, detached: true });
    expect(model.detachedIds).toEqual(['orphan']);
  });

  it('terminates on self-links and cycles without dropping or duplicating nodes', () => {
    const model = buildConversationChainTree([
      node('selfie', { parentConversationId: 'selfie' }),
      node('x', { parentConversationId: 'y' }),
      node('y', { parentConversationId: 'x' }),
    ]);
    const ids = flatten(model.roots).map((entry) => entry.id);

    expect([...ids].sort()).toEqual(['selfie', 'x', 'y']);
    expect(new Set(ids).size).toBe(3);
  });

  it('reports live work through every ancestor of an active descendant', () => {
    const model = buildConversationChainTree([
      node('root'),
      node('idle', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('live', {
        active: true,
        status: 'running',
        parentConversationId: 'idle',
        rootConversationId: 'root',
      }),
    ]);

    expect(chainBranchIsActive(model.roots[0])).toBe(true);
    expect(chainBranchIsActive(model.roots[0].children[0])).toBe(true);
    expect(chainBranchIsActive(model.roots[0].children[0].children[0])).toBe(true);
  });
});
