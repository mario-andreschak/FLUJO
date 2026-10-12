# Capture lane receipt

Completed October 11, 2026. The parent chat owns integration, PR validation and publication. This lane changed only `githubpages/assets/journeys/` and `docs/journeys/evidence/` in the `codex/readme-website-journeys-20261011` worktree, based on `569079d632a19f100c3bb194e7036aaba5cdc283`. It made no commits and did not change the primary checkout.

- **Evidence:** [screenshot manifest](capture-manifest.json), [capture provenance](capture-provenance.md), [runtime events and transcripts](journey-runtime-evidence.json), [reusable exporter](export-journey-evidence.mjs), and the [reviewed four-part workshop pack](workshop-pack.md).
- **Real software:** published `flujo-ai@3.46.2`, Node 24.21.0, Bun 1.4.3, Chromium on Debian/Xfce. The documentation checkout is version 3.46.3. Eighteen unmodified 1600×1000 desktop PNGs were visually reviewed and their dimensions, timestamps and hashes verified.
- **Connected app:** `zcaceres/fetch-mcp` at `1ddb1a59cb09a2d38e759f2d7a97829680cbe514`, package 1.1.2. Successful local build, stdio `node dist/index.js`, six discovered tools. The helper's corrected result used a successful `fetch_readable` call with `max_length: 20000` against the public About Coffee guide. Initial truncation, incorrect answer, retry and correction remain in the evidence.
- **Persona acceptance:** Maya produced a plan, DRAFT invitation, shopping list and 90-minute run sheet. The actual saved goal completed after four controller sessions, and all four child tasks are completed. Final task quantities match the reviewed pack: 500 g regular coffee, 100 g decaf, 40+ filters, 10 L water, 24 tasting cups and three shared equipment sets; a fourth lead set is optional. Approval-memory recovery and a final quantity consistency correction were required. The completed root card retains a stale next-action sentence. “Day 1–3” are compressed sessions on the same date, not elapsed days. This was agent-operated software with operator review, not a human usability study.
- **Provider usage:** OpenRouter `google/gemini-3-flash-preview` (saved alias Workshop AI). The exported 47 dispatches record 403,919 input and 7,588 output tokens; 219,059 cached input is a subset of input. Actual monetary cost is unavailable because runtime cost fields are placeholders. Recorded run window: 19m54.258s; summed execution: 162.073s. These exclude setup and measure different things.
- **Supplemental installation:** the original install preceded recording. A separately recorded genuine second install used a previously absent `/workspace/install-take` prefix and existing npm download cache. It installed 551 packages in a measured 55.335s. The first launch encountered an occupied port 4201; port 4300 then returned HTTP 200 and opened the fresh setup page. The receipt and recording preserve the npm warnings and port recovery.

## Private recordings

The following recordings are retained as private local deliverables outside the repository:

| File | Duration | Bytes |
| --- | --- | --- |
| `first-use-recording.mp4` | 31m48.9s | 25,514,192 |
| `clean-install-take.mp4` | 4m20.7s | 2,879,292 |

Both MP4 hashes match the captured originals; hashes are in the manifest. Private install logs and the append-only capture log accompany them. Public PNGs were visually checked for credential exposure, and public text artifacts passed an exact-value check against both provider credentials. No credential values were found. The private raw videos have not received a frame-by-frame privacy audit and are not public repository assets.

The supplemental installation and disposable downloads were cleaned up after verification. Private delivery paths, live runtime handles and administrative cleanup receipts are retained in the project's private handover, outside this public evidence package.
