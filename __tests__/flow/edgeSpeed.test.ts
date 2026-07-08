import {
  edgeSpeedFactor,
  BASE_ANIMATION_MS,
  BASE_ANIMATION_BOTH_MS,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges/edgeSpeed';

// Issue #66: give sibling edges on the same handle a slight, deterministic
// variation in dash-animation speed so overlapping edges drift out of phase.
describe('edgeSpeedFactor', () => {
  const ids = [
    'e1',
    'reactflow__edge-nodeA-nodeB',
    'reactflow__edge-source1handle-target2handle',
    'xy-edge__abc-def',
    '',
    '0',
    'a'.repeat(64),
  ];

  it('always returns a multiplier within [0.90, 1.10]', () => {
    for (const id of ids) {
      const f = edgeSpeedFactor(id);
      expect(f).toBeGreaterThanOrEqual(0.9);
      expect(f).toBeLessThanOrEqual(1.1);
    }
  });

  it('is deterministic for a given id (no flicker across re-renders)', () => {
    for (const id of ids) {
      expect(edgeSpeedFactor(id)).toBe(edgeSpeedFactor(id));
    }
  });

  it('varies across different ids (so siblings drift apart)', () => {
    const distinct = new Set(
      Array.from({ length: 50 }, (_, i) => edgeSpeedFactor(`reactflow__edge-n${i}`))
    );
    // Not all identical — the whole point of the feature.
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('produces a sane, in-range animation duration in ms', () => {
    for (const id of ids) {
      const oneWay = Math.round(BASE_ANIMATION_MS * edgeSpeedFactor(id));
      const both = Math.round(BASE_ANIMATION_BOTH_MS * edgeSpeedFactor(id));
      expect(oneWay).toBeGreaterThanOrEqual(Math.round(BASE_ANIMATION_MS * 0.9));
      expect(oneWay).toBeLessThanOrEqual(Math.round(BASE_ANIMATION_MS * 1.1));
      expect(both).toBeGreaterThanOrEqual(Math.round(BASE_ANIMATION_BOTH_MS * 0.9));
      expect(both).toBeLessThanOrEqual(Math.round(BASE_ANIMATION_BOTH_MS * 1.1));
    }
  });
});
