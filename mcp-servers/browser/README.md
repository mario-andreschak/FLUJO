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

## Recording length and parts

There is no fixed time limit. Video frames go from Chromium straight into the
encoder, which writes the WebM file as it goes, and page audio is appended to a
WAV file as it arrives, so memory use stays flat however long a recording runs.
Only the files grow, so the limit is free disk space:

- `durationMs` is honoured as given. Values below 250 ms are raised to 250 ms
  and say so in `warnings`. A value that is not a number is refused with a
  clear message. If the operator set `FLUJO_BROWSER_RECORD_MAX_MS`, longer
  requests are refused with a message naming that setting; nothing is
  shortened silently.
- The start result reports `maxDurationMs`: how long the free space lasts at
  this size, counting the copies made when the video is saved. It is an
  estimate, not a cutoff. When `durationMs` is longer, the result also has a
  `diskWarning`, and the recording still starts.
- Every recording leaves 2% of the disk free (at least 256 MB, at most 2 GB)
  so the computer keeps working. Every few seconds it checks the recordings
  folder and the temp folder. It stops early only when free space drops below
  that amount plus the room needed to save what was already recorded. The video
  is then saved, `stopReason` is `low-disk`, and a warning explains what to do.
  A recording does not start at all if the disk is already that full
  (`DISK_LOW`); it works again as soon as space is freed.
- A session is never closed for being idle while it records. ffmpeg (for
  muxing or converting) gets at least as long as the recording itself.

Stopping a recording does not close its browser session: the page keeps its
state, and `stopReason` tells why it stopped (`requested`, `auto-stop`,
`low-disk`, `session-closed`, `shutdown`). To record long runs in parts:

1. `browser_record_start` returns a `sessionId`.
2. `browser_record_stop` saves the current part. Its result has
   `sessionClosed: false`.
3. `browser_record_start { sessionId }` records the next part on the same page
   with a new `recordingId` and `segment` number.
4. `browser_record_stop { closeSession: true }` saves the last part and closes
   the session. Otherwise it closes after the normal idle timeout.

Calling `browser_record_start { sessionId, durationMs }` while that session is
still recording changes when it stops, counted from now. When the session limit
is full, a new recording first closes the oldest kept-open recording session
that is no longer recording, and says so in `warnings`.

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
