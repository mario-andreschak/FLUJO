# One-goal Persona acceptance

Issue #505 adds a product acceptance scenario separate from the runtime soak.
It creates an isolated workspace, persisted Marketing Role, Frederik Persona,
model configuration and one ongoing goal through production service APIs.
The production goal controller, mailbox/dispatcher, `runFlow`, model handler,
MCP transport, native outcome reporter and durable work records execute.
The harness observes after assignment; it never supplies another user task.

In the product UI, leaving success criteria empty creates an indefinite
responsibility (`completionPolicy: until_stopped`). The controller keeps it active
even if a model mistakenly reports the whole goal achieved. Explicit success
criteria create a finite goal; the owner can change automatic completion in the
goal card. The acceptance scenario below deliberately uses finite criteria so its
verified end state is observable. Older saved goals without this optional policy
retain completion on verified success criteria.

## Running

No paid model request is made by the default offline mode:

```sh
node --test scripts/persona-goal-acceptance/fixture.test.mjs
node --test scripts/persona-goal-acceptance/evidence.test.mjs
node scripts/run-persona-goal-acceptance.mjs --mode=offline --timeout-seconds=600
```

The opt-in live mode uses the installed Codex SDK and the operator's existing
Codex authentication. It makes real model requests and executes the actual tool
bridge. Preflight imports the genuine SDK without requesting a completion:

```sh
node scripts/run-persona-goal-acceptance.mjs --mode=live --preflight=true
node scripts/run-persona-goal-acceptance.mjs --mode=live --model=gpt-6-astra --timeout-seconds=600
```

For the stronger terminal-only scenario, the Persona receives just a general
terminal as its external capability. It must install and use real headless
Chromium, discover/read the local research website, create the artifacts and
recover from the publication outage. The README provides endpoints and success
criteria; it does not prescribe commands or a browser-installation sequence.

```sh
node --test scripts/persona-goal-acceptance/terminal-fixture.test.mjs
node scripts/run-persona-goal-acceptance.mjs --mode=live --tools=terminal-only --model=gpt-6-astra --timeout-seconds=1200
```

This opt-in executes model-chosen shell commands and downloads real dependencies
and browser binaries into a unique fixture directory. It does not use public
social accounts. The initially empty fixture is observed before setup; temporary
files and dependency caches default to local subdirectories.
`PLAYWRIGHT_BROWSERS_PATH` defaults to a local directory, and the model may choose
any other installation path inside the fixture. A Node
preload observer records actual Chromium child launches without substituting
browser APIs, and the research page reports browser-rendered source content to
the local HTTP server. Both launch and HTTP evidence are required. HTTP user-agent
claims or model-authored “browser proof” files alone do not pass. Verification
resolves the launched executable against the immutable fixture root, independent
of the model's selected browser environment; paths and symlinks outside the
fixture fail. This observer is
an integration measurement, not an adversarial attestation system.

Run from the repository root after installing its normal dependencies. Results
default to a unique `goal-acceptance-artifacts/<run-id>/` directory. Optional
`--output=<directory>` requires an empty directory so prior evidence is preserved.
The runner prints the exact output path. Never run multiple live modes merely to
work around provider limits; inspect a failed run before retrying.

The SDK is ESM-only while Jest transforms dynamic imports to CommonJS. A custom
test environment imports the genuine SDK outside the Jest VM and exposes its exact
constructor to the application adapter. This is a module-loader compatibility
shim; SDK/CLI execution, authentication and model reasoning remain real. Offline
mode alone substitutes completion methods on the OpenAI adapter with a scripted
model. It still calls the real engine and all tools through MCP.

## Scenario and verification

The initial goal is to research a controlled FLUJO campaign page, author
`research.md` and `launch.md`, and publish the launch artifact. Every run receives
new random source/fact identifiers. Verification reads the actual files and
publication state, requires the exact source ID, audience and benefit, and
compares the published content hash to the launch artifact. Model prose or file
existence alone cannot satisfy the checks.

In the default structured-tools scenario, the research client starts missing. The agent can inspect a README through a
bounded terminal and run an actual local Node installer, then use the installed
client to retrieve research. This tests repairing a controlled setup dependency;
it does not install an operating-system browser. Publication first fails with a
retryable service outage and an actual time window. Success requires a later
successful publication; publication is idempotent after success.

The authored Role permits one artifact per Activity, forcing multiple durable
continuations. This is a controlled continuation test, not proof that a model
independently invents a marketing strategy. After the first completed progress
round the harness stops and starts the goal controller, without resubmitting
the goal. A later persisted Activity must demonstrate resumed scheduling.
This is a controller restart, not an OS process-kill test.

Required observations include one persisted initial goal, at least three distinct
autonomous mailbox/Activity admissions, verified deliverables and publication,
recovery from the setup dependency and service outage, continued scheduling
after controller restart, zero human input/requests and no premature terminal
stop. Model identity is captured at the actual completion boundary. Conversation
messages, runtime snapshots, Activities, mailbox records and fixture audit events
are retained for review.

## Evidence limits

`persona-goal-acceptance.json` binds mode, model/adapter/configuration, commit SHA,
run ID, timestamps and a hash covering tracked changes plus untracked source
files. `SHA256SUMS` covers that JSON. A working-tree run must be described using
both its base commit and source-diff hash; it is not evidence for the pristine
base commit. Fixture effects are local controlled external services, not public
Reddit/LinkedIn actions. The harness does not exercise the wizard/browser UI,
CAPTCHAs, third-party authentication, real public
marketing quality, rate-limit endurance, or weeks of real elapsed time.
Only the terminal-only variant exercises real browser installation/use; the
default structured-tools scenario does not.

An offline pass is evidence about integration mechanics, not model capability.
A live pass demonstrates only this finite, explicitly bounded scenario with the
reported model and configuration. Neither replaces #448's exact-release soak
and controlled 50k memory evidence or establishes a “99% unattended” rate.

The `persona-goal-acceptance` workflow runs the scripted-model, real-tools variant
for pull requests and manual dispatch, builds the first-party MCP packages and
preserves its evidence artifacts. CI does not spend an operator's Codex account
or silently substitute offline results for live-model acceptance. The existing
full-soak workflow and unresolved #448 release contracts remain separate.

The runner validates successful evidence by independently reading the real fixture
files/state again and checking persisted mailbox-to-Activity links, distinct round
admissions, model identity and checksums. To validate a preserved report directly:

```sh
node scripts/validate-persona-goal-acceptance.mjs --directory=<run-directory> --commit=<reported-sha> --mode=live
```

## Observed production UI acceptance

On 2026-09-06 UTC, the production UI at commit
`8960664be87de8f56a5bb66e0e584fba8f04c552` was exercised with Frederik,
the Marketing Agent Role, genuine Codex Astra, and browser/filesystem tools.
The paused goal survived application restart. The operator saved
`until_stopped`, verified it after a page reload, and selected Continue.
Astra read a local README snapshot, created and verified three campaign files,
saved a child task, and reported progress. The controller started that child
60.567 seconds after the first round finished without another work prompt.

Selecting Stop during the child round cancelled its Activity and dispatch within
648 ms. No further admissions appeared during 292 seconds of observation.
The root remained stopped, with no pending admission or next wake; the unfinished
child commitment and campaign files remained saved. New-goal defaults, operating
limits, Activity history, and saved Tasks were also inspected in the browser.

The local report is
`goal-acceptance-artifacts/production-ui-2026-09-06/production-ui-observation.json`
(SHA-256 `08d302ee41e72868e43255a643da5a6e558535d0983651cc4bef85eb86bd2961`).
Its accompanying clarifications distinguish the manual server launch and
operator policy/Continue/Stop controls from zero additional work prompts or
approval replies during autonomous execution. Two earlier development-server
lease failures are retained in the evidence. This short local-drafts run does
not establish public marketing effectiveness or a 99% unattended rate.

The walkthrough also exposed a browser App preview ownership mismatch: browser
research succeeded, but the App reconnected using the conversation ID instead
of the originating logical run ID. That observed failure is retained separately
from the successful Persona continuation and Stop evidence in issue #505.
