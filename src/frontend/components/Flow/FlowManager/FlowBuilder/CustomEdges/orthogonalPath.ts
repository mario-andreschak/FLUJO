import { Position } from '@xyflow/react';

/**
 * Orthogonal (axis-aligned) edge routing through user-placed waypoints —
 * draw.io-style. Unlike getSmoothStepPath's center parameters (which are
 * ignored whenever the default route is a straight line), the path built
 * here is guaranteed to pass through every waypoint.
 */

export interface Point {
  x: number;
  y: number;
}

type Axis = 'h' | 'v';

/** A rendered straight piece of the polyline, tagged with the gap between
 * anchor points (source = gap 0 … target) it belongs to — used to decide
 * where a newly dragged-out waypoint is inserted. */
export interface PathSegment {
  a: Point;
  b: Point;
  gap: number;
}

export interface OrthogonalPath {
  d: string;
  /** The corner points of the polyline, in order (including endpoints). */
  points: Point[];
  segments: PathSegment[];
  /** Point halfway along the polyline — where the edge controls sit. */
  midpoint: Point;
}

export function axisFromPosition(position: Position): Axis {
  return position === Position.Left || position === Position.Right ? 'h' : 'v';
}

const eq = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/** Minimum straight run through a bend point. Without it, a route that has
 * to double back (e.g. a waypoint pulled below a horizontal edge) collapses
 * into a zero-width hairpin spike. */
const MIN_RUN = 24;

/**
 * Build an orthogonal polyline source -> w1 -> … -> wn -> target.
 *
 * Leaving each anchor, the route alternates axes (leave a waypoint along the
 * axis it was entered on, turned 90°), starting along the source handle's
 * axis; the final approach into the target always runs along the target
 * handle's axis, inserting a half-way double elbow when the axes don't line
 * up.
 */
export function buildOrthogonalPath(
  source: Point,
  sourceAxis: Axis,
  target: Point,
  targetAxis: Axis,
  waypoints: Point[],
  borderRadius = 8
): OrthogonalPath {
  const anchors = [source, ...waypoints, target];
  const points: Point[] = [source];
  // gapOf[i] = which anchor gap produced polyline segment i.
  const gapOf: number[] = [];
  let axis: Axis = sourceAxis;

  const push = (p: Point, gap: number) => {
    const prev = points[points.length - 1];
    if (eq(prev, p)) return;
    points.push(p);
    gapOf.push(gap);
  };

  for (let i = 1; i < anchors.length; i++) {
    const prev = points[points.length - 1];
    const next = anchors[i];
    const gap = i - 1;
    const isLast = i === anchors.length - 1;

    if (isLast) {
      if (targetAxis === 'v') {
        // Final segment must run vertically into the target.
        if (axis === 'h') {
          push({ x: next.x, y: prev.y }, gap);
        } else {
          const midY = (prev.y + next.y) / 2;
          push({ x: prev.x, y: midY }, gap);
          push({ x: next.x, y: midY }, gap);
        }
      } else {
        // Final segment must run horizontally into the target.
        if (axis === 'v') {
          push({ x: prev.x, y: next.y }, gap);
        } else {
          const midX = (prev.x + next.x) / 2;
          push({ x: midX, y: prev.y }, gap);
          push({ x: midX, y: next.y }, gap);
        }
      }
      push(next, gap);
    } else {
      // Pass through the waypoint: leave prev along the current axis, arrive
      // at the waypoint along the other, then continue turned 90°.
      if (axis === 'v') {
        push({ x: prev.x, y: next.y }, gap);
      } else {
        push({ x: next.x, y: prev.y }, gap);
      }
      push(next, gap);
      axis = axis === 'v' ? 'h' : 'v';
    }
  }

  widenHairpins(points, gapOf);

  const segments: PathSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({ a: points[i], b: points[i + 1], gap: gapOf[i] });
  }

  return {
    d: roundedPathD(points, borderRadius),
    points,
    segments,
    midpoint: pointAlong(points, 0.5),
  };
}

/**
 * Replace doubled-back runs with a proper U. A route that must return the
 * way it came (segment i and i+1 collinear but opposite) would render as a
 * zero-width spike with two coincident lines; instead the apex gets a
 * MIN_RUN-wide straight run — the bend point ends up mid-segment, like
 * draw.io. Mutates points/gapOf in place.
 */
function widenHairpins(points: Point[], gapOf: number[]): void {
  const d = MIN_RUN / 2;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1];
    const apex = points[i];
    const q = points[i + 1];

    const verticalHairpin =
      Math.abs(p.x - apex.x) < 0.01 && Math.abs(q.x - apex.x) < 0.01 &&
      (apex.y - p.y) * (q.y - apex.y) < 0; // direction reverses
    const horizontalHairpin =
      Math.abs(p.y - apex.y) < 0.01 && Math.abs(q.y - apex.y) < 0.01 &&
      (apex.x - p.x) * (q.x - apex.x) < 0;

    if (!verticalHairpin && !horizontalHairpin) continue;

    if (verticalHairpin) {
      // Approach the run from the side the path comes from, leave on the other.
      const cameFromLeft = (points[i - 2]?.x ?? apex.x - 1) <= apex.x;
      const enterX = cameFromLeft ? apex.x - d : apex.x + d;
      const exitX = cameFromLeft ? apex.x + d : apex.x - d;
      const gap = gapOf[i - 1];
      points.splice(i - 1, 3,
        { x: enterX, y: p.y },
        { x: enterX, y: apex.y },
        { x: exitX, y: apex.y },
        { x: exitX, y: q.y }
      );
      gapOf.splice(i - 1, 2, gap, gap, gap);
    } else {
      const cameFromAbove = (points[i - 2]?.y ?? apex.y - 1) <= apex.y;
      const enterY = cameFromAbove ? apex.y - d : apex.y + d;
      const exitY = cameFromAbove ? apex.y + d : apex.y - d;
      const gap = gapOf[i - 1];
      points.splice(i - 1, 3,
        { x: p.x, y: enterY },
        { x: apex.x, y: enterY },
        { x: apex.x, y: exitY },
        { x: q.x, y: exitY }
      );
      gapOf.splice(i - 1, 2, gap, gap, gap);
    }
    i++; // the widened run cannot hairpin again at the same spot
  }
}

/** SVG path through the given corner points with rounded corners. */
function roundedPathD(points: Point[], radius: number): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${corner.x},${corner.y}`;
      continue;
    }
    const inPoint = {
      x: corner.x - ((corner.x - prev.x) / inLen) * r,
      y: corner.y - ((corner.y - prev.y) / inLen) * r,
    };
    const outPoint = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    d += ` L ${inPoint.x},${inPoint.y} Q ${corner.x},${corner.y} ${outPoint.x},${outPoint.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x},${last.y}`;
  return d;
}

/** The point a given fraction (0..1) along the polyline's length. */
export function pointAlong(points: Point[], fraction: number): Point {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  if (total === 0) return points[0];
  let remaining = total * fraction;
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (remaining <= len) {
      const t = len === 0 ? 0 : remaining / len;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    remaining -= len;
  }
  return points[points.length - 1];
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Which anchor gap the given point is closest to — i.e. the waypoint-array
 * index at which a new waypoint grabbed there should be inserted. */
export function nearestGap(point: Point, segments: PathSegment[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (const seg of segments) {
    const dist = distToSegment(point, seg.a, seg.b);
    if (dist < bestDist) {
      bestDist = dist;
      best = seg.gap;
    }
  }
  return best;
}
