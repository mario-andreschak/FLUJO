/**
 * Unit tests for the chat sidebar "by chain" tree builder (issue #182).
 *
 * `buildChainIndex` turns the flat conversation list into a parent->children
 * index + root set for the recursive `ConversationTree`. These tests pin the
 * contract the render layer relies on: correct nesting, sibling lanes under one
 * parent, orphan/self-parent conversations rendered as roots (so nothing ever
 * disappears), and — defensively — a corrupt parent-link *cycle* degrading to
 * visible roots rather than vanishing.
 */
import { buildChainIndex } from '@/utils/shared/conversationChains';
import type { ConversationListItem } from '@/frontend/components/Chat';

const conv = (
  id: string,
  parentConversationId?: string | null,
): ConversationListItem => ({
  id,
  title: id,
  flowId: 'flow-1',
  createdAt: 0,
  updatedAt: 0,
  parentConversationId: parentConversationId ?? null,
});

describe('buildChainIndex (issue #182)', () => {
  it('nests a Flow -> A -> B chain under its root', () => {
    const items = [conv('root'), conv('A', 'root'), conv('B', 'A')];
    const { roots, childrenByParent } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['root']);
    expect(childrenByParent.get('root')!.map((c) => c.id)).toEqual(['A']);
    expect(childrenByParent.get('A')!.map((c) => c.id)).toEqual(['B']);
    expect(childrenByParent.get('B')).toBeUndefined();
  });

  it('keeps multiple children (parallel lanes) under the same parent, in order', () => {
    const items = [conv('parent'), conv('lane1', 'parent'), conv('lane2', 'parent')];
    const { roots, childrenByParent } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['parent']);
    expect(childrenByParent.get('parent')!.map((c) => c.id)).toEqual(['lane1', 'lane2']);
  });

  it('renders a child whose parent is absent from the set as a root (orphan fallback)', () => {
    // e.g. a filter hid the parent, or the parent was deleted.
    const items = [conv('child', 'missing-parent')];
    const { roots, childrenByParent } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['child']);
    expect(childrenByParent.size).toBe(0);
  });

  it('treats a self-referential parent link as a root', () => {
    const items = [conv('self', 'self')];
    const { roots, childrenByParent } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['self']);
    expect(childrenByParent.get('self')).toBeUndefined();
  });

  it('promotes cycle members to roots so a corrupt chain never disappears', () => {
    // A -> B -> A: neither is a "no parent" root, so without the cycle safety
    // net both would be dropped. They must still surface.
    const items = [conv('A', 'B'), conv('B', 'A')];
    const { roots } = buildChainIndex(items);

    expect(roots.map((r) => r.id).sort()).toEqual(['A', 'B']);
  });

  it('handles an empty list', () => {
    const { roots, childrenByParent } = buildChainIndex([]);
    expect(roots).toEqual([]);
    expect(childrenByParent.size).toBe(0);
  });
});
