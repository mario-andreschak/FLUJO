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
  rootConversationId?: string | null,
): ConversationListItem => ({
  id,
  title: id,
  flowId: 'flow-1',
  createdAt: 0,
  updatedAt: 0,
  parentConversationId: parentConversationId ?? null,
  rootConversationId: rootConversationId ?? null,
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

  it('flags an orphan promoted to the top level as detached, and never flags a genuine root', () => {
    // The sidebar must be able to tell "automation/user chat started this"
    // apart from "this is a subagent whose parent we simply didn't load".
    const items = [conv('real-root'), conv('orphan', 'missing-parent')];
    const { roots, detachedIds } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['real-root', 'orphan']);
    expect(detachedIds.has('orphan')).toBe(true);
    expect(detachedIds.has('real-root')).toBe(false);
  });

  it('re-attaches a child to its chain root when the direct parent is not loaded', () => {
    // The common real-world case: the sidebar is paginated (50/page) and the
    // intermediate subflow parent fell off the page, so `B` would otherwise
    // render as a first-level row next to real automations.
    const items = [conv('root'), conv('B', 'missing-middle', 'root')];
    const { roots, childrenByParent, detachedIds } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['root']);
    expect(childrenByParent.get('root')!.map((c) => c.id)).toEqual(['B']);
    // Still detached: it is nested under a grandparent, not its real parent.
    expect(detachedIds.has('B')).toBe(true);
  });

  it('does not attach to a loaded rootConversationId that is itself a child', () => {
    // Corrupt/stale lineage must not fabricate an edge under an unrelated
    // non-root conversation merely because its id happens to be loaded.
    const items = [conv('actual-root'), conv('not-a-root', 'actual-root'), conv('orphan', 'missing', 'not-a-root')];
    const { roots, childrenByParent, detachedIds } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['actual-root', 'orphan']);
    expect(childrenByParent.get('actual-root')!.map((c) => c.id)).toEqual(['not-a-root']);
    expect(childrenByParent.get('not-a-root')).toBeUndefined();
    expect(detachedIds.has('orphan')).toBe(true);
  });

  it('prefers the direct parent over rootConversationId when both are loaded', () => {
    const items = [conv('root'), conv('mid', 'root', 'root'), conv('leaf', 'mid', 'root')];
    const { roots, childrenByParent, detachedIds } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['root']);
    expect(childrenByParent.get('root')!.map((c) => c.id)).toEqual(['mid']);
    expect(childrenByParent.get('mid')!.map((c) => c.id)).toEqual(['leaf']);
    expect(detachedIds.size).toBe(0);
  });

  it('does not self-nest when rootConversationId points at the conversation itself', () => {
    const items = [conv('self-root', 'missing-parent', 'self-root')];
    const { roots, childrenByParent, detachedIds } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['self-root']);
    expect(childrenByParent.size).toBe(0);
    expect(detachedIds.has('self-root')).toBe(true);
  });

  it('rejects a root fallback that would form a cycle and keeps every conversation once', () => {
    // A claims B as its root, but B is already a child of A. The fallback is
    // rejected, leaving A visible as detached and B on its valid direct edge.
    const items = [conv('A', 'missing', 'B'), conv('B', 'A')];
    const { roots, childrenByParent, detachedIds } = buildChainIndex(items);

    expect(roots.map((r) => r.id)).toEqual(['A']);
    expect(childrenByParent.get('A')!.map((c) => c.id)).toEqual(['B']);
    expect(childrenByParent.get('B')).toBeUndefined();
    expect(detachedIds.has('A')).toBe(true);
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
    const { roots, childrenByParent, detachedIds } = buildChainIndex([]);
    expect(roots).toEqual([]);
    expect(childrenByParent.size).toBe(0);
    expect(detachedIds.size).toBe(0);
  });
});
