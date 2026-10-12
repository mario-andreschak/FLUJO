# Reference-flow subflow-session acceptance — 2026-10-12

Existing [issue #391](https://github.com/mario-andreschak/FLUJO/issues/391) is qualified on source revision `1f2f5bc5a1cbe6eaec40c785d3fe0767cf2f477f`, application build `hdCEw8W6XANOg97FrC-Ar`, version 3.46.3. Both real `Website_Promo_Video_Producer` runs completed with `PASS_WITH_ADVISORIES`. Repeat research calls retained one child conversation when its saved scope was `per-run`; the absent-scope baseline created two children.

The recoverable [receipt](evidence/reference-subflow-391-2026-10-12/receipt.json) contains source/flow fingerprints, exact task, provider counters, child IDs, completed registry visits, timings and media identity. The [reference flow bundle](evidence/reference-subflow-391-2026-10-12/reference-flows.json) excludes credentials and replaces the authored project path with `<PROJECT_ROOT>`. Map its existing model bindings to GPT-6 Astra through Codex, using low reasoning for this comparison, and connect the existing filesystem, bash, browser and ElevenLabs servers. Only the repeated researcher node opts into `per-run`; independent scene jobs retain their original scopes.

## Reproduced problems and correction

The original callable path forced children to be ephemeral and omitted saved session settings. A real reference run consequently created different child IDs despite `per-run`. Inline calls now share graph key resolution, honor per-run/per-key memory, and pass summary/turn-cap controls. Fresh visits, unresolved keys, ephemeral parents and explicit no-save settings retain ephemeral behavior. Checkpointed graph-join recovery remains separate.

The next live run exposed a second failure: native parallel tools were recorded as consecutive empty assistant call entries followed by their matching results. Transcript validation wrongly replaced that complete child as corrupt. Validation now recognizes a complete parallel bundle within the same node/depth while continuing to reject missing/orphan results, duplicate calls and boundaries crossed before completion. Both failures have regressions that failed before their corrections.

## Comparable baseline and measurement

A cold reference run on `c1e711a0` first produced the actual 30-second video, narration, music, eight scene renders and first-party research packet. Final comparison workspaces received identical copies of that completed project, with empty conversation/session stores. Path-bearing text was rebased to each isolated root. Both final runs used the same graph, task, model, low reasoning effort and valid media; the repeated research node's scope differed. This measures a **warm delivery rerun with a research follow-up**, not a second cold 900-frame production workload.

| Recorded result | Fresh-child baseline | Saved child reuse |
|---|---:|---:|
| Parent status | completed | completed |
| QC verdict | PASS_WITH_ADVISORIES | PASS_WITH_ADVISORIES |
| Prompt tokens | 3,161,812 | 2,847,958 |
| Cached prompt tokens | 2,823,424 | 2,548,864 |
| Uncached prompt tokens | 338,388 | 299,094 |
| Completion tokens | 11,229 | 11,025 |
| Wall time, seconds | 515.339 | 479.895 |
| Native provider threads with reported usage | 8 | 8 |
| Research child conversations | 2 | 1, visited twice |

Counters are the final cumulative native-provider counters per unique thread, including ephemeral children. All eight threads on each side reported usage. Timings are measured independently; the runs overlap and their durations must not be added. Provider dollar charges were not returned, so no dollar-savings estimate is made.

The observed prompt difference is **313,854 tokens (9.9%)**, including 39,294 fewer uncached prompt tokens. This is one stochastic pair, with different model-selected tool sequences; it is not a causal estimate or a general guarantee. The older roughly **700K prompt-token savings** note has no recovered paired receipt and remains an unverified historical anecdote. This evidence does not reproduce its reported expensive recapture pattern. A stable FLUJO child conversation is demonstrated; fewer native provider threads are not claimed.

The reusable child is `97b7dfdc-f54c-4c15-9112-15f5472778c5`, with two top-level user turns and registry `visits: 2, status: idle`. The baseline calls returned `a3850814-f668-4a7d-b8e6-9b59f20c16f5` and `e3b22128-7369-452a-9bde-a826e270cce0`.

## Media, UI and validation

Both final exports retain SHA-256 `e56fa1c5c4dcb5ad70bb16958b152b98f6bd0c3cbf7827753a52501ee524b7f4`: 6,520,625 bytes, H.264 1920×1080, 30 fps, 900 frames, 30.000 seconds, AAC 48 kHz stereo. The identical media passed a full decode; that unchanged result is reused. Actual QC records are [baseline](evidence/reference-subflow-391-2026-10-12/session-fresh-qc.json) and [reuse](evidence/reference-subflow-391-2026-10-12/session-reuse-qc.json).

The [sampled frames](evidence/reference-subflow-391-2026-10-12/video-contact.png) show usable first-party visuals and supported copy. QC advisories remain accurate: reuse rights are unverified, some screenshot text is small, and audio was checked analytically without a subjective listening review. No repair was required.

The completed parent result is visible on [desktop](evidence/reference-subflow-391-2026-10-12/desktop.png) and [390×844 phone](evidence/reference-subflow-391-2026-10-12/phone.png), without horizontal overflow. Local `C:/` links in the FLUJO transcript had blank destinations; the verified video and project are preserved as local deliverables outside that transcript. The isolated profile also lacks an MCP Apps sandbox. Neither observation is treated as successful published-App or artifact-link acceptance.

38 focused session, transcript recovery, tool schema and Persona-authority regressions passed. Fresh application typecheck/lint and the inspected non-container build passed for the final implementation; unchanged MCP type/build evidence was reused. No full suite, remote CI, container/image build or release check was dispatched. This source-built receipt does not complete #572's published-install, upgrade, form, full-provider, accessibility/language or novice acceptance.
