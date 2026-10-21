# Google model setup handover

- Owner: this chat. Branch `codex/antigravity-setup-recovery`; validated source
  revision `f5ab7a1645ce930c486257eeac44384bbfbc474f`.
- Delivery: [draft PR #1221](https://github.com/mario-andreschak/FLUJO/pull/1221).
  This handover records the source revision; no merge or release was requested.
- Delivered: official `agy` detection/installation (including Windows's known
  install directory without a PATH refresh), no shipped `flujo-agy` wrapper,
  dynamic CLI catalog and recovery UI. Gemini Native now uses Interactions for
  unary, streaming and restricted assessment calls. Existing API keys and model
  IDs remain valid. FLUJO owns history (`store: false`) and tool execution;
  signed native steps survive canonical assistant writeback and projection.
  Output limits, usage/cache/thinking telemetry, media and cancellation remain
  supported. Argon exposes low/medium/high thinking and hides temperature.
- CLI research, 2026-10-19: official Windows CLI and installer manifest both
  report 1.4.2. The Gemini-key catalog has 11 entries and omits Argon. Isolated
  offline probes reject both `gemini-4-argon` and `gemini-4-argon-high` before
  inference (zero turns/usage). The binary already contains Argon strings.
  [Google CLI issue #1228](https://github.com/google-antigravity/antigravity-cli/issues/1228)
  documents the same API-key catalog omission; reports persist after the Pro
  account rollout. Account mode and Gemini-key mode have different catalogs.
  No binary patches, fabricated catalog entries or account entitlement claims.
- Google recommends [Interactions](https://ai.google.dev/gemini-api/docs/migrate-to-interactions);
  GenerateContent remains supported. The [Argon announcement](https://antigravity.google/blog/gemini-4-argon-in-google-antigravity)
  does not require a CLI. Native discovery still reads Google's paginated
  `models.list`; the CLI list is the list the installed CLI accepts.
- Validation for the source revision: full local typecheck; source lint and
  changed-fixture lint; non-container application build, including MCP builds;
  diff whitespace check. Build ID `qEcqzcVLqfV-ZALmEr_84`. Regression fixtures
  cover signed/parallel tool replay after persistence, streaming fragments,
  media, cancellation, incomplete/error responses, one-attempt transport and
  restricted assessment. Suites were updated but NOT run: broad suites, remote
  CI and container builds remain release pre-flight gates under the user's policy.
- Live app: localhost:4200, launcher PID 33352, Next PID 34108; normal `.next`
  build path, generated route types refreshed after activation. Logs/evidence:
  `C:/Users/Moe/.codex/visualizations/2026/10/19/01a155e5-bc06-70c3-bdd8-dcb8c8632483/`.
- User-authorized Google Argon acceptance, 2026-10-19 (local date): existing
  Gemini 4 Argon, `gemini-4-argon`, model ID
  `a907238c-eee3-443d-a9db-1a039783e54f`, default-workspace. Native provider and
  adapter remain `gemini`; its encrypted key still exactly matches Antigravity
  CLI Default (`32463ede-b34a-4201-b3dd-0a335238b444`). Neither connection was
  reconfigured during this migration.
- Normal Test model dialog passed through Interactions: HTTP 200 / `pong` in
  6,520 ms; FLUJO tool schema/arguments/execution/result-receipt check in
  14,998 ms. Evidence: `argon-interactions-live-test.png` in the folder above.
- Actual streamed Flow passed in 10,494 ms: one synthetic session `todo` call,
  executed result, and exact generated todo ID returned by Argon. Durable roles
  were user/assistant/tool/assistant. Both assistant turns retained signed
  native steps; archive operations were two `interactions.create(stream)`
  calls. Only `gemini-4-argon` was invoked. Evidence summary:
  `argon-interactions-stream.json`. Temporary conversation/logs/archive removed.
  Provider billing cost was not exposed; no monetary cost is asserted. Direct
  user authorization in this chat covered these tests only and does not transfer.
- Earlier official CLI acceptance remains valid for its unchanged source:
  HTTP 200 / `pong` in 5,810 ms and FLUJO tool test in 10,141 ms. Evidence:
  `antigravity-live-test.png`. The original CLI connection remains `default`.
- Cleanup through flujo-bash: removed research scratch (158,521 bytes), replaced
  build/compiler caches and disposable model-turn archive (75,759,946 bytes),
  plus the temporary conversation through the normal deletion API. No Docker
  images/caches or scratch dependency installations were created. Active build,
  active MCP output, credentials, service logs and evidence retained. Free disk
  after cleanup: 178,609,381,376 bytes. Original user changes in `AGENTS.md` and
  legacy `packages/antigravity-cli/bin.cjs` remain untouched and uncommitted.
- Compatibility note: Interactions has no numeric thinking-budget field. An old
  explicit budget fails with recovery guidance; opening/saving the model clears
  it, and thinking-level selection is available. Argon's existing setup required
  no change. There is no silent legacy API/model/provider fallback.
- Next: review the draft PR; run the retained broad/packaged regression and
  release checks immediately before a release. No active blocker remains.
