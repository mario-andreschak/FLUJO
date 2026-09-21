# Persona beginner browser journey

The opt-in Playwright suite in `e2e/personas/journey.spec.mjs` exercises the ten-step journey required by #435 against a production Next build. Run it separately from Jest. It uses a fresh temporary data root, two workspaces, a local OpenAI-compatible model double, and a real stdio MCP receipt App. Only the model, example Core/Behavior Flows and App connections are prepared by the fixture; the Role, Persona, selected Apps, Memory and saved Task are authored through the browser.

This is functional integration evidence, not genuine-model quality or endurance evidence. It does not replace the #489 soak/50k benchmark, #505 real-provider acceptance, or the [manual release and recovery checklist](../planning/personas-redesign/manual-acceptance-and-recovery.md).

## Run

Use Node 22 and the repository's locked dependencies:

```sh
npm ci
npx playwright install --with-deps chromium
npm run build
node --test scripts/persona-browser-acceptance/evidence.test.mjs
npm run test:persona-browser-fixture
npm run test:persona-browser-environment
npm run test:persona-browser
```

The default application port is 4286. `PERSONA_JOURNEY_PORT` selects another unused local port. `PERSONA_JOURNEY_APP_DIR` can select an already-built disposable checkout; its build ID is recorded. The launcher never attaches to an existing app process and never reuses an existing data root. A busy port fails startup. Do not point it at a production checkout with an in-progress build. The fixture redirects its daily telemetry to its own local endpoint.

The UI scenario checks:

1. Role creation with two suggested Apps.
2. Persona creation, retaining one App and replacing the other.
3. A model-ready Core and a shared Behavior, followed by a Persona-owned copy.
4. Memory creation, correction/history, pin/unpin, cancellation and confirmed forget.
5. A Persona conversation whose Core actually invokes the copied Behavior and granted App.
6. A saved Task queued behind held App work, with visible waiting state and disabled duplicate assignment.
7. Graceful process shutdown/restart with the same data root; one recovered Task Activity, one App effect, and an explicit successful semantic outcome.
8. History type/status/date filtering, configuration download privacy, deletion-preview cancellation/focus, and a foreign-workspace lookup rejected with 404.

The scripted model reports success only after receiving the real fixture receipts. It calls `report_activity_outcome` before finishing when available. A finished Activity with an unknown outcome does not pass the Task-completion assertion. Fixture protocol tests use the real OpenAI SDK to decode both streaming and nonstreaming responses.

The environment tests use the production build to check graceful stop/restart and a busy-port refusal. The launcher waits for readiness on its own child's private IPC channel before sending any HTTP request, so a pre-existing listener cannot be mistaken for the fixture server.

## Evidence and limits

The manual-dispatch workflow `persona-browser-journey.yml` requires a full lowercase `commit_sha`. Dispatch its definition from the repository's default branch. It checks out the selected SHA and verifies that the commit belongs to that trusted workflow history before installing dependencies or building. For example, after selecting the release commit:

```sh
gh workflow run persona-browser-journey.yml --ref <default-branch> -f commit_sha=<full-release-sha>
```

The workflow checks for a clean checkout before building. Next may regenerate its ambient type imports in `next-env.d.ts`; the workflow retains that diff in `next-env-build.patch` and restores only that generated file before checking source again. Other tracked, staged or untracked source changes fail the check. Source checks immediately before and after the browser command record the selected commit, unique Actions run/attempt identity and build ID. They must bracket the report's execution times.

Playwright writes an embedded JSON report to `persona-browser-artifacts/report.json`. The independent validator requires exactly one passing journey, all nine ordered test steps covering the ten-step product journey, no skips/retries/reporter errors, matching source/run/build identities, and complete observations. It also checks persisted copy/grant/Memory/Task state, an explicit succeeded Task outcome, two stopped process epochs, and exactly one chat/Task App effect. Missing, partial or mismatched evidence fails. Repeated failed checks overwrite earlier passing summaries; a stale `acceptance.json` cannot survive a failed validation attempt.

The artifact `persona-browser-<commit>-<run-id>-<attempt>` retains `persona-browser-artifacts`, `test-results/personas` and `playwright-report/personas` for 90 days, with SHA-256 checksums. Every test attaches its step results, persisted Persona state, model/App receipts and process epochs. Failure traces/screenshots and the downloaded configuration are retained. These artifacts contain only synthetic fixture content. Temporary application data and detailed process logs remain at the path printed in the observations; the suite stops only its own processes.

After downloading the artifact, verify `persona-browser-artifacts/SHA256SUMS` from its root, then independently validate using the selected release SHA, Actions run/attempt and build ID from the run record:

```sh
node scripts/persona-browser-acceptance/validate.mjs \
  --directory /path/to/download/persona-browser-artifacts \
  --commit <full-release-sha> --run-id <actions-run-id>-<attempt> \
  --build-id <recorded-build-id>
```

The report embeds the required JSON attachments, so validation does not follow absolute paths from the original runner. A local diagnostic without the CI source/run identities can still exercise the UI and produce useful reports, but cannot pass this release-evidence validator. Validator unit fixtures are rejection/format tests, not browser-journey evidence.

The September audit authored this suite and verified its operations through CUA, correcting fixture defects along the way. It also verified the artifact rejection rules and source guards locally. That is not a clean execution of the standalone Playwright test or a completed CI release gate. Run and stabilize the entire suite on the selected clean release commit before marking Browser CI Journey accepted. Require both the CI job and artifact validator to pass, and record the CI URL in the manual checklist.

Recovery ZIP upload/restore/reconnection, historical migration shapes, all seven rendered locales, full keyboard/screen-reader/zoom assessment, approved performance budgets and recovery-branch sign-off remain separate checklist gates. This initial suite uses English and does not claim to complete those gates.

For a manual/CUA run with the same fixture preparation:

```sh
node scripts/persona-browser-acceptance/serve.mjs /absolute/path/to/built/checkout 4286
```

The process prints its URL and fresh data path. `inspect` prints observations; `restart` performs the owned graceful stop/start; `release` releases held `JOURNEY_BUSY` work; `stop` closes the fixture and app. Browser actions remain visible product actions; do not substitute API mutations for a UI acceptance step. Any browser-tool confirmation rules still apply to actual uploads or deletions.
