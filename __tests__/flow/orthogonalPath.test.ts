/**
 * Tests for the draw.io-style orthogonal edge routing
 * (src/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges/orthogonalPath.ts).
 *
 * The guarantee under test: the polyline ALWAYS passes through every
 * waypoint — including the horizontally-aligned straight-line case where
 * getSmoothStepPath's center parameters silently do nothing.
 */
import {
  buildOrthogonalPath,
  nearestGap,
  pointAlong,
  Point,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges/orthogonalPath';

const passesThrough = (points: Point[], p: Point): boolean =>
  points.some((a, i) => {
    if (i === points.length - 1) return false;
    const b = points[i + 1];
    const onH = a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
    const onV = a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
    return onH || onV;
  });

describe('buildOrthogonalPath', () => {
  it('routes a horizontally-aligned edge through a waypoint below it (the stranded-grip case)', () => {
    // Two nodes side by side (MCP wiring), waypoint dragged below the line.
    const wp = { x: 620, y: 590 };
    const routed = buildOrthogonalPath(
      { x: 490, y: 470 }, 'h',
      { x: 780, y: 470 }, 'h',
      [wp]
    );
    expect(passesThrough(routed.points, wp)).toBe(true);
    // Start and end run along the handles' axes.
    expect(routed.points[0]).toEqual({ x: 490, y: 470 });
    expect(routed.points[routed.points.length - 1]).toEqual({ x: 780, y: 470 });
    const last = routed.points[routed.points.length - 1];
    const beforeLast = routed.points[routed.points.length - 2];
    expect(beforeLast.y).toBe(last.y); // horizontal final approach
  });

  it('routes a vertical flow edge through multiple waypoints in order', () => {
    const w1 = { x: 200, y: 300 };
    const w2 = { x: 500, y: 380 };
    const routed = buildOrthogonalPath(
      { x: 330, y: 250 }, 'v',
      { x: 330, y: 500 }, 'v',
      [w1, w2]
    );
    expect(passesThrough(routed.points, w1)).toBe(true);
    expect(passesThrough(routed.points, w2)).toBe(true);
    const last = routed.points[routed.points.length - 1];
    const beforeLast = routed.points[routed.points.length - 2];
    expect(beforeLast.x).toBe(last.x); // vertical final approach
  });

  it('produces only axis-aligned segments', () => {
    const routed = buildOrthogonalPath(
      { x: 0, y: 0 }, 'v',
      { x: 300, y: 200 }, 'v',
      [{ x: 150, y: 120 }, { x: 40, y: 170 }]
    );
    for (let i = 0; i < routed.points.length - 1; i++) {
      const a = routed.points[i];
      const b = routed.points[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('widens a doubled-back route into a U instead of a zero-width hairpin', () => {
    // Waypoint pulled straight below a horizontal edge: the naive route goes
    // down and back up on the same pixel column. The built path must instead
    // give the bend a straight run (the waypoint sits mid-segment) and never
    // reverse direction within a column/row.
    const wp = { x: 620, y: 590 };
    const routed = buildOrthogonalPath(
      { x: 490, y: 470 }, 'h',
      { x: 780, y: 470 }, 'h',
      [wp]
    );
    expect(passesThrough(routed.points, wp)).toBe(true);
    for (let i = 1; i < routed.points.length - 1; i++) {
      const p = routed.points[i - 1];
      const apex = routed.points[i];
      const q = routed.points[i + 1];
      const verticalReversal = p.x === apex.x && q.x === apex.x && (apex.y - p.y) * (q.y - apex.y) < 0;
      const horizontalReversal = p.y === apex.y && q.y === apex.y && (apex.x - p.x) * (q.x - apex.x) < 0;
      expect(verticalReversal || horizontalReversal).toBe(false);
    }
    // The straight run through the waypoint has real width.
    const run = routed.points.filter(p => p.y === wp.y);
    expect(run.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(run[run.length - 1].x - run[0].x)).toBeGreaterThanOrEqual(20);
  });

  it('puts the midpoint on the polyline', () => {
    const routed = buildOrthogonalPath(
      { x: 0, y: 0 }, 'v',
      { x: 100, y: 100 }, 'v',
      [{ x: 50, y: 50 }]
    );
    expect(passesThrough(routed.points, routed.midpoint)).toBe(true);
  });
});

describe('nearestGap', () => {
  it('inserts before an existing waypoint when grabbing the first stretch, after it on the last', () => {
    const wp = { x: 100, y: 100 };
    const routed = buildOrthogonalPath({ x: 0, y: 0 }, 'v', { x: 200, y: 200 }, 'v', [wp]);
    // Grab near the source: belongs to gap 0 (insert before the waypoint).
    expect(nearestGap({ x: 1, y: 20 }, routed.segments)).toBe(0);
    // Grab near the target: belongs to gap 1 (insert after the waypoint).
    expect(nearestGap({ x: 199, y: 190 }, routed.segments)).toBe(1);
  });
});

describe('pointAlong', () => {
  it('returns the halfway point of a simple L', () => {
    const mid = pointAlong([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 0.5);
    expect(mid).toEqual({ x: 100, y: 0 });
  });
});
