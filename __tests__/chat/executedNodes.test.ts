/**
 * Tests for deriveExecutedNodeIds (issue #213) — the pure helper behind the
 * Chat "Executed Steps" path panel. It merges three fallback sources
 * (per-message processNodeId, the node execution tracker, the debug execution
 * trace) into a de-duped, first-seen-ordered list of executed node ids.
 */
import { deriveExecutedNodeIds } from '@/utils/shared/executedNodes';

describe('deriveExecutedNodeIds', () => {
  it('returns an empty array when nothing is provided', () => {
    expect(deriveExecutedNodeIds({})).toEqual([]);
    expect(deriveExecutedNodeIds({ messages: null, nodeExecutionTracker: null, executionTrace: null })).toEqual([]);
  });

  it('derives ids from per-message processNodeId (append-style log fallback)', () => {
    const ids = deriveExecutedNodeIds({
      messages: [
        { processNodeId: 'start' },
        { /* no node */ },
        { processNodeId: 'A' },
        { processNodeId: 'B' },
      ],
    });
    expect(ids).toEqual(['start', 'A', 'B']);
  });

  it('derives ids from the node execution tracker', () => {
    const ids = deriveExecutedNodeIds({
      nodeExecutionTracker: [{ nodeId: 'start' }, { nodeId: 'A' }, { /* none */ }],
    });
    expect(ids).toEqual(['start', 'A']);
  });

  it('derives ids from the debug execution trace', () => {
    const ids = deriveExecutedNodeIds({
      executionTrace: [{ nodeId: 'start' }, { nodeId: 'C' }],
    });
    expect(ids).toEqual(['start', 'C']);
  });

  it('unions all three sources and de-dupes (looped nodes listed once)', () => {
    const ids = deriveExecutedNodeIds({
      messages: [{ processNodeId: 'start' }, { processNodeId: 'A' }],
      nodeExecutionTracker: [{ nodeId: 'A' }, { nodeId: 'B' }],
      executionTrace: [{ nodeId: 'B' }, { nodeId: 'A' }],
    });
    expect(ids).toEqual(['start', 'A', 'B']);
    // de-duped
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only includes the branch actually taken (B-only, C stays absent)', () => {
    const bOnly = deriveExecutedNodeIds({
      messages: [{ processNodeId: 'start' }, { processNodeId: 'A' }, { processNodeId: 'B' }, { processNodeId: 'finish' }],
    });
    expect(bOnly).toContain('B');
    expect(bOnly).not.toContain('C');

    const cOnly = deriveExecutedNodeIds({
      messages: [{ processNodeId: 'start' }, { processNodeId: 'A' }, { processNodeId: 'C' }, { processNodeId: 'finish' }],
    });
    expect(cOnly).toContain('C');
    expect(cOnly).not.toContain('B');
  });
});
