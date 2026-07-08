// Pure helpers for the edge dash-animation speed. Kept in their own module so
// they can be unit-tested without pulling in React / @xyflow / MUI (the
// FlowEdgeBase.tsx renderer imports these).

// Base dash-animation durations (ms). Named constants so the CSS defaults in
// FlowEdgeBase's styled component and the per-edge speed variation stay in sync.
export const BASE_ANIMATION_MS = 500;
export const BASE_ANIMATION_BOTH_MS = 750;

/**
 * Deterministic 0.90–1.10 multiplier derived from a stable string (the edge
 * id). Sibling edges sharing a handle animate at slightly different speeds and
 * drift out of phase (easier to tell apart), while staying stable across
 * re-renders (no Math.random flicker/jitter).
 */
export const edgeSpeedFactor = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  const unit = (Math.abs(h) % 1000) / 1000; // 0..0.999
  return 0.9 + unit * 0.2;                   // 0.90..1.10
};
