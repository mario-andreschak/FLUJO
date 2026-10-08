# Browser MCP

The browser MCP provides interactive Patchright sessions, deterministic PNG capture, and WebM recording.

## Evidence artifacts

`browser_screenshot` creates an immutable PNG by default under
`screenshots/browser/<sessionId>/<artifactId>-viewport.png` (or
`-full-page.png`). An optional `outputPath` is accepted only inside the
FLUJO data directory or configured screenshot root. Existing destinations,
root escapes, drive-relative/device/UNC paths, and symlink or junction escapes
are rejected.

Screenshot results include the artifact ID, SHA-256, capture timestamp, CSS
viewport, DPR, encoded PNG dimensions, and page/session metadata. When the
target is an active recording, the result also links the PNG to its
`recordingId` and configured recording geometry. PNGs are lossless evidence;
callers must still freeze application animation, timestamps, cursors, and
changing overlays before exact comparisons.

## Recording geometry

Recording contexts use an explicit CSS viewport and device scale factor 1.
The configured video surface matches that viewport. Recording sessions have a
fixed viewport policy: resizing the MCP App or dock scales/letterboxes the live
stream and never mutates the page used to produce evidence.

Start, status, and stop results distinguish:

- `requestedViewport`
- `actualViewport`
- `deviceScaleFactor`
- `configuredVideoResolution`
- `actualEncodedVideoResolution` (after finalization, or `null` with a warning)
- content bounds, letterbox insets, and `geometryMismatch`

WebM remains review/playback evidence; use recording-linked PNG screenshots for
exact pixel evidence.

## Session lifecycle and ownership

The backend-provided `_meta.flujo.ownerScope` is authoritative. Calls without
metadata use the process-local `legacy:anonymous` compatibility scope.
Session IDs cannot be listed, used, attached, stopped, or closed across owner
scopes. The live-view gateway additionally requires a private per-session
capability delivered to the MCP App through result metadata.

Capacity is reserved synchronously before browser creation, so concurrent opens
cannot race above `FLUJO_BROWSER_MAX_SESSIONS`. Dead and expired entries are
reclaimed before enforcing the cap. `browser_list_sessions` returns
owner-filtered lifecycle/capacity diagnostics, and `browser_release_owner`
idempotently finalizes recordings and releases sessions for the caller scope.
