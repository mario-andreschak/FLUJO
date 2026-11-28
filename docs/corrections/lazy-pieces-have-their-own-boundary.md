# Lazy pieces load through `src/frontend/lazy`, so a chunk that fails to load never takes down the screen

On a slow PC the animated background's chunk timed out. It was loaded with a
bare `next/dynamic`, so the failure reached the app's error boundary and "The
workspace hit a snag" replaced the whole screen. Now every lazy piece picks
its recovery by what it is:

- `lazyOptional` for pieces the screen works without (decorations, overlays,
  docks): its own boundary shows nothing and loads the piece again later by
  itself, with no page reload.
- `lazyEssential` for pieces the screen needs: a failed chunk is fetched again
  with backoff before the error page shows, and the error page keeps trying
  by itself (`HealAfterChunkFailure`) until the workspace comes back.

Enforced by:
- `flujo/lazy-load-needs-boundary`
- `__tests__/frontend/components/lazyPiece.test.tsx`
