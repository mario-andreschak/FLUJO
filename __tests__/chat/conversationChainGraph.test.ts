/**
 * Pure-unit tests for the chain-chat building blocks (issue #405):
 *  - the active-status allowlist,
 *  - the latest-displayable-message extraction,
 *  - the React-Flow graph adapter built on top of `buildChainIndex()`.
 */
import {
  ACTIVE_CONVERSATION_STATUSES,
  isActiveConversationStatus,
} from '@/utils/shared/conversationActivity';
import {
  extractLatestDisplayableMessage,
  extractMessageText,
} from '@/utils/shared/conversationPreview';
import { buildChainGraphModel } from '@/utils/shared/conversationChainGraph';
import type { ConversationChainNode } from '@/shared/types/conversationChain';

const node = (
  id: string,
  overrides: Partial<ConversationChainNode> = {},
): ConversationChainNode => ({
  id,
  title: id,
  active: true,
  createdAt: 1,
  updatedAt: 1,
  parentConversationId: null,
  rootConversationId: null,
  lastMessage: null,
  ...overrides,
});

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

describe('latest displayable message extraction', () => {
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

  it('picks the newest visible user/assistant message and skips the rest', () => {
    const preview = extractLatestDisplayableMessage([
      { role: 'user', content: 'older', timestamp: 1 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }], timestamp: 2 },
      { role: 'tool', content: 'tool output', timestamp: 3 },
      { role: 'assistant', content: 'the\n\nanswer', timestamp: 4 },
      { role: 'system', content: 'system prompt', timestamp: 5 },
    ]);
    expect(preview).toEqual({ role: 'assistant', text: 'the answer', timestamp: 4, truncated: false });
  });

  it('skips disabled (reverted) messages', () => {
    const preview = extractLatestDisplayableMessage([
      { role: 'user', content: 'kept', timestamp: 1 },
      { role: 'assistant', content: 'reverted', timestamp: 2, disabled: true },
    ]);
    expect(preview?.text).toBe('kept');
  });

  it('bounds the preview and returns null for empty or malformed input', () => {
    const preview = extractLatestDisplayableMessage([{ role: 'user', content: 'x'.repeat(50) }], 10);
    expect(preview).toMatchObject({ truncated: true });
    expect(preview?.text).toHaveLength(11);

    expect(extractLatestDisplayableMessage([])).toBeNull();
    expect(extractLatestDisplayableMessage(undefined)).toBeNull();
    expect(extractLatestDisplayableMessage([null, 42, { role: 'system', content: 'x' }])).toBeNull();
  });
});

describe('chain graph adapter', () => {
  it('returns an empty model for empty input', () => {
    expect(buildChainGraphModel([])).toEqual({ nodes: [], edges: [], detachedIds: [] });
  });

  it('places a branch deterministically and emits parent -> child edges', () => {
    const model = buildChainGraphModel([
      node('root'),
      node('a', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('b', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('a1', { parentConversationId: 'a', rootConversationId: 'root' }),
    ]);

    expect(model.nodes.map((n) => n.id)).toEqual(['root', 'a', 'a1', 'b']);
    expect(model.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 1]);
    expect(model.edges.map((e) => e.id)).toEqual(['root->a', 'a->a1', 'root->b']);
    // Same input, same layout: stable snapshots, no visual jumping.
    expect(buildChainGraphModel([
      node('root'),
      node('a', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('b', { parentConversationId: 'root', rootConversationId: 'root' }),
      node('a1', { parentConversationId: 'a', rootConversationId: 'root' }),
    ])).toEqual(model);
  });

  it('flags nodes whose parent is missing and still renders them', () => {
    const model = buildChainGraphModel([
      node('root'),
      node('orphan', { parentConversationId: 'gone', rootConversationId: 'root' }),
    ]);

    expect(model.nodes.map((n) => n.id).sort()).toEqual(['orphan', 'root']);
    expect(model.detachedIds).toEqual(['orphan']);
    expect(model.nodes.find((n) => n.id === 'orphan')?.detached).toBe(true);
    expect(model.edges.map((e) => e.id)).toEqual(['root->orphan']);
  });

  it('terminates on self-links and cycles without dropping nodes', () => {
    const model = buildChainGraphModel([
      node('selfie', { parentConversationId: 'selfie' }),
      node('x', { parentConversationId: 'y' }),
      node('y', { parentConversationId: 'x' }),
    ]);

    expect(model.nodes.map((n) => n.id).sort()).toEqual(['selfie', 'x', 'y']);
    expect(new Set(model.nodes.map((n) => n.position.y)).size).toBe(3);
  });
});
