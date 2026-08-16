# Durable model-turn timeline

## Goal

Chat exposes an immutable timeline of the requests that FLUJO actually attempted
to dispatch to model SDKs. Selecting a marker compares the lossless canonical
conversation at that moment with the final provider-facing wire and the exact,
sanitized SDK request parameters.

Predictive node previews remain available only as an explicitly labelled preview
after a user selects a node in the executed-flow panel. A preview never substitutes
for a missing historical record.

## Units and identity

- A **dispatch** is one invocation of a provider SDK/CLI with one concrete request.
  It is the atomic timeline marker.
- Dispatches carry the logical run id and Process-node id/name so the UI can group
  adjacent markers by user turn and node visit.
- Provider retries and self-orchestrated internal calls are separate dispatches;
  the UI may visually cluster them, but every request remains selectable.
- A request that fails before the SDK boundary creates no historical dispatch.

## Durable record

The conversation log receives a lightweight `model:dispatch` event containing an
id, node/model attribution, adapter/method, status, and a reference to a compressed
sidecar. The sidecar contains:

- canonical threaded messages at dispatch time;
- final generic wire messages after FLUJO compaction/refitting/cache ordering;
- provider-native SDK request parameters after adapter translation;
- input-mode provenance and visual-compaction diagnostics when available;
- sanitized model settings and tool schemas;
- media descriptors and content-addressed blob references.

Credentials, authorization headers, cookies, and provider response bodies never
enter the archive.

## Media

Capture occurs after run-resource hydration and provider translation. Data URLs and
provider-native base64 blocks are extracted from the SDK request, decoded once, and
stored by SHA-256. The request JSON retains a typed placeholder with the original
parameter path, MIME type, encoding, byte size, and hash. Remote URLs are retained
only after credential-like query values are redacted.

The inspector renders supported images/audio/video inline and exposes file metadata.
Raw base64 is not dumped into the DOM; the archived bytes remain available from a
conversation-authorized media endpoint.

## Read path

- `GET /v1/chat/conversations/:id/model-turns` returns a small chronological index.
- `GET /v1/chat/conversations/:id/model-turns/:dispatchId` lazily loads one sidecar.
- `GET /v1/chat/conversations/:id/model-turns/:dispatchId/media/:mediaId` streams one
  authorized archived media blob.
- Legacy conversations return an empty index and never fabricate history from the
  predictive projection.

## Chat behavior

- Timeline markers live in the Chat header and select immutable historical records.
- Hover+wheel, click, arrow keys, Home, and End navigate the timeline.
- Selecting the last marker enables Follow Live automatically.
- Moving to an older marker disables Follow Live.
- When Follow Live is active, a new marker becomes selected automatically.
- Otherwise the selection stays fixed and a "new turns" affordance jumps to the end.
- Desktop uses canonical/wire comparison tabs with an optional split layout; mobile
  uses tabs. Request details include SDK parameters, tools, settings, and media.

## Lifecycle and safety

- Model-turn archives use the active workspace data directory.
- Conversation deletion removes its model-turn sidecars and conversation-scoped,
  content-addressed media blobs.
- Ephemeral runs do not write model-turn archives.
- Persona/activity authority is checked at the same final dispatch boundary as the
  provider call; archive failures are observability failures and must not block the
  model request.

## Verification

Tests cover request/response and self-orchestrating adapters, media extraction,
secret redaction, retry ordering, persistence across reload, conversation deletion,
legacy empty state, canonical/wire fidelity, predictive separation, navigation, and
automatic Follow Live reactivation at the tail.
