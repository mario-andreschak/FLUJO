# Source operations recovery acceptance for #570

The existing [production acceptance issue #570](https://github.com/mario-andreschak/FLUJO/issues/570)
now has a reproducible integrated source drill for provider failures, owner expiry,
retained approval and graceful restart. It uses actual built Next routes, the
ordinary scheduler/Flow engine, the shipped Bash app and private owner issuance.
All model requests go to an owned loopback provider. The tool appends a counted
synthetic disk effect inside one explicitly allowed disposable directory.

## Observed result

The [frozen receipt](evidence/operations-recovery-570-2026-10-14/receipt.json)
records ten passing observations and fifteen actual provider requests on Windows
10.0.19045.0 x64 / Node 22.23.3. Application source is
`bbf0a5fa471c28ce9e46f34f1e5f4ee60572bf29`; build
`VlPTwXvxS3UfYxpim-Z3w` is bound to 1,868 relevant source inputs and 1,539
emitted Next/five-MCP files. Qualification equipment is hashed separately.

| Case | Actual observation |
| --- | --- |
| Owner and encryption | Anonymous operations access refused; locked storage refused; private passphrase initialization/authentication and authenticated readiness succeeded. Operations samples contained no fixture credentials or model output. |
| Provider-reported timeout / 429 / 400 | The real adapter made 3 / 3 / 1 failed requests respectively. Each run retained its error and the matching diagnostic hint. Explicit retry created a distinct run, made one successful request and preserved the expected answer and original failed history. |
| Expired owner with pending approval | Operations and approval writes returned 401. The same approval/run stayed present; the tool wrote nothing. The original private policy was restored in `finally`. |
| Graceful restart | Both owned Next child exits were observed as 143. The new process required encryption unlock, had a different diagnostic correlation UUID and dispatched no model/tool work automatically. The pending run and approval survived. |
| Stale tool recovery | The old tool registration was safely refused. A new proposal used a distinct tool-call ID and paused for explicit approval. It wrote nothing before that decision and exactly one counted effect afterward. The completed run retained the expected answer. |
| Replay and denial | Replaying the completed approval returned 404. Denying a separate proposal wrote nothing; the existing effect count stayed one. |
| MCP shutdown | Explicit disable produced named Bash receipts with `owned` / `observed_exit`. Operations matched each process-local runtime UUID and generation. Private data was removed only after those observations and owned Next close. |

The two cleanup failure controls actually injected loss of an enable response and
a scenario deadline while the temporary owner policy was expired. Each runner
returned the expected failure (exit 1), restored cleanup authority where needed,
observed Bash/Next exit and verified removal of its private root. Their captured
injected-error witnesses and log hashes are in the receipt; a requested fault
label alone does not establish that the fault occurred.

Three admission negatives refused changed source hashes, changed emitted hashes
and an occupied build log before launching private equipment or a build. The
occupied-log case preserved the existing log and emitted bytes. Uncertain
pre-consent launch/exit remains a conservative retain-and-diagnose failure, never
an absence inferred only from generation zero.

## Reproduce the source drill

From a clean pinned application checkout, install its exact lock with
`npm ci --include=dev`, then use new absolute receipt paths:

```sh
node scripts/operations-acceptance/build-evidence.mjs --report <absolute-build.json>
node scripts/smoke-operations-recovery.mjs --report <absolute-journey.json> --build-evidence <absolute-build.json>
```

The build recorder admits the inspected non-container application/five-MCP build,
opens its new log before spawning, verifies unchanged source inputs and binds
the actual emitted bytes. The drill refuses a stale receipt, creates its own
protected owner/data/home, uses literal loopback listeners and verifies cleanup.
It inherits no model credentials. Run task-owned cleanup and deletions through
flujo-bash under the project rules.

Focused failure controls use separate new report paths and the same admitted
build, adding `--fail-at enable-response` or
`--fail-at expired-owner-deadline`. Expect a failed outcome/exit 1, the specific
injected-error witness, matching shutdown observations and `cleanupVerified`.

## Local qualification and remaining criteria

Source types (61.383s), five-MCP types (9.554s), source lint (100.462s), 36 focused
operations/approval regressions (5.379s), changed-equipment lint/syntax checks and
the inspected application/five-MCP build (325.851s) passed. Times are individual;
development checks overlapped. The final equipment passed independent read-only
review. Application source, lock and build inputs stayed unchanged while the
equipment was corrected; the valid build was reused.

HTTP 408 is a **provider-reported** timeout. The five-hour SDK elapsed timeout,
abrupt crash/restart, worker authority/epoch fencing, opted-in recurring catch-up
and copied-schedule suppression remain separate acceptance. Disk-full,
interrupted migration and snapshot restore still need their integrated matrix.
No detached descendant or isolated-container removal is inferred from Next exit.

Independent operator installation/diagnosis/backup/upgrade/restore and exact
supported release profiles remain release pre-flight. No cloud inference,
provider billing, installed distribution, container build, full suite or remote
workflow was performed here. Issue #570 remains open with its original criteria.
