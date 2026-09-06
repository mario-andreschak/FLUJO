# Persona goal endurance acceptance

Issue #505 has three distinct evidence tiers. The deterministic Persona soak uses a
virtual clock and stubbed model boundary. The finite one-goal acceptance exercises the
production flow engine and controlled tools. This endurance tier adds real elapsed time,
ordinary ongoing-goal policy, OS-process restart/kill recovery, scheduled owner controls,
and independently verified external effects.

A pass supports only the exact mode and capability profile in its report. The default
service is disposable and controlled; it is not evidence of public internet reach,
third-party account creation, VM isolation, marketing quality, or a population-level
“99% unattended” claim.

## Safety and authorization

Execution is opt-in. The runner rejects calls without
`--confirm=controlled-effects`, enforces one concurrent campaign per run, and accepts
only the controlled fixture. The fixture manifest permits one idempotent publication,
requires cleanup, references credentials by environment name, caps payloads and attempts,
and never stores the ephemeral bearer token in evidence.

Genuine public services are intentionally unavailable from this generic harness. They
need a reviewed service-specific adapter, approved accounts/effects, credential
references, identity/CAPTCHA policy, rate limits, cleanup authority and an explicit
operator approval ID. A hosted fixture remains controlled evidence even if it is
reachable over the public internet.

## Running

Install normal repository dependencies and build the first-party MCP packages. An
offline mechanics run is non-authoritative but exercises production persistence,
dispatch, tools and process ownership:

```sh
node scripts/run-persona-goal-endurance.mjs \
  --mode=offline \
  --profile=structured-tools \
  --duration-seconds=300 \
  --active-seconds=280 \
  --round-seconds=10 \
  --round-limit=80 \
  --max-model-calls=1280 \
  --budget-usd=0 \
  --confirm=controlled-effects
```

A genuine-model run uses the installed Codex SDK and the operator's existing Codex
authentication:

```sh
node scripts/run-persona-goal-endurance.mjs \
  --mode=live \
  --model=gpt-6-astra \
  --profile=structured-tools \
  --duration-seconds=3600 \
  --active-seconds=3540 \
  --round-seconds=60 \
  --round-limit=100 \
  --max-model-calls=1600 \
  --budget-usd=25 \
  --confirm=controlled-effects
```

The terminal-only profile deliberately fails closed. A general host terminal is not a
security boundary: it could inherit credentials, access unrelated paths, or reach
unapproved network destinations. Terminal-only endurance can be enabled only after a
separate runner supplies OS-process containment, a network allowlist, secret isolation,
and trusted process/browser auditing. The finite terminal fixture remains integration
evidence and is not reused as endurance containment.

`--output=<empty-directory>` preserves a caller-selected evidence path.
`--run-id=<stable-id>` binds workflow/reviewer identity.
`--total-timeout-seconds` sets one whole-run deadline and must leave at least five
minutes beyond the requested duration. Every phase receives only the remaining budget,
with a final cleanup/attestation reserve. The hard `--max-model-calls` limit is enforced
across checkpointed process epochs before a new provider request; the round limit and
per-Activity turn limit provide additional bounds. `--budget-usd` records the separately
pre-approved provider/account ceiling.

The runner accepts 60 seconds through 28 real days, but GitHub-hosted workflow input is
limited to three hours. The workflow grants the runner a ten-minute cleanup/deadline reserve and leaves the remaining job lifetime for checkout, dependency setup, validation and artifact upload.
Longer approved trials require a persistent runner with a documented retention owner.

The proposed three 24-hour runs, seven-day pilot and 28-day real-time trial remain
future release policy, not automatic gates.

## Scenario and process boundaries

The first process creates exactly one fresh `until_stopped` goal named “Make FLUJO known
on the internet” for Persona Frederik using Role Marketing Agent. The Role has ordinary
instructions to research, create useful artifacts, maintain a backlog, recover, reconcile
uncertain effects and continue. It has no one-artifact-per-Activity constraint.

The first process observes at least one durable round and exits gracefully. The second
process starts against the same `FLUJO_DATA_DIR`, reconciles the Persona, and continues
without goal resubmission. The controlled service rate-limits the first publish attempt.
On the next attempt it commits the publication under a stable idempotency key and
withholds the acknowledgement. Once the protected service record and running Activity
are checkpointed, the runner force-kills the complete Jest/MCP process tree.

A third process starts against the same persisted workspace. It must produce a fresh
Activity, read back the uncertain effect, preserve exactly one publication, create
further verified progress, survive scheduled Pause and Continue, and end only through a
scheduled Stop. Stop revokes execution while drafts/history remain. The harness then
cleans up the controlled publication.

Each process records PID and the production process-birth marker. Checkpoints form a
SHA-256 chain. An interrupted run remains `incomplete` and is never replaced by a later
attempt.

## Evidence

The output directory contains:

- `persona-goal-endurance.json` — identity, configuration, intervals, raw metric
  numerators/denominators, controls, persisted goal/Activity/mailbox records and claims;
- `checkpoints/0001.json` through `0003.json` — graceful, effect-before-ack and recovered
  process epochs with a hash chain;
- `runtime-model-turns.json` — parent-collected model dispatches and outcomes from the
  production compressed model-turn archive, linked to the three process epochs;
- `runtime-provenance.json` — parent-collected durable runtime events and dispatches with
  source-file digests, used instead of report-authored copies for identity joins;
- `trusted-verifier/manifest.json`, `state.json` and `audit.jsonl` — protected service
  policy, observations, publication/read-back and cleanup;
- `agent-workspace/` — model-writable campaign artifacts;
- `runner-state.json` — resumability/failure status and the runner-owned key fingerprint;
- `SHA256SUMS` — report, checkpoint and trusted-evidence hashes;
- `evidence-attestation.json` and `attestation-public.pem` — an Ed25519 signature created
  by the parent runner only after all three child processes exit.

Trusted records live outside `agent-workspace/`. Child processes never receive the
attestation private key. The runner prints the public-key SHA-256 fingerprint to the
workflow log and stores it in runner state; preserve that external log value with the
artifacts. The service binds research, launch and backlog content to random per-run facts
and SHA-256 hashes. It records rate limiting,
effect commit with lost acknowledgement, later read-back reconciliation, and cleanup.
Model prose and file existence alone do not establish progress. Live-model claims require
completed `codex-cli` `thread.runStreamed` records collected by the parent runner from
the production model-turn archive; the test-side call counter is only a budget guard.

`eligibleRounds` is the count of unique persisted controller admissions linked to an
Activity. `autonomousEligibleRounds` excludes rounds with unscheduled human input,
manual retry, approval or permission intervention. `unattendedRoundRate` is the raw
numerator divided by the denominator; a zero denominator cannot pass. The Activity
attributed to scheduled Continue/manual retry is excluded from the autonomous numerator.
The runtime appends strict `goal:control` and `goal:round` records. A durable control
outbox keeps the state transition, event identity and affected dispatch IDs recoverable
until the event and cancellations are settled. Those records link Pause/Retry/Stop state
transitions and each reservation cause through dispatch, mailbox and Activity identities. Due-but-never-admitted work is reconstructed from due
round records with no admitted Activity and reported separately. Total interventions include initial setup,
scheduled process faults and Pause/Continue/Stop; unscheduled interventions are also
reported separately.

Real duration is reconstructed from contiguous active, paused and downtime wall-clock
intervals spanning all three process epochs. Clock gaps, overlaps or derived virtual
time fail validation. Verified progress counts Activities independently linked by
timestamps to verified artifact/effect observations. Output quality stays
`not_evaluated` until a separate reviewer scores the fixed rubric; quality review does
not alter autonomy metrics.

Validate a preserved successful run independently:

```sh
node scripts/validate-persona-goal-endurance.mjs \
  --directory=<run-directory> \
  --commit=<reported-commit> \
  --mode=live \
  --profile=structured-tools \
  --source-diff=<reported-source-diff-sha256> \
  --attestation-key-sha256=<fingerprint-from-runner-log>
```

The validator rejects wrong revision/mode/profile, manifest drift, forged checkpoint
chains, process identity reuse, unsafe Activity replay, duplicate effects, missing
read-back, tampered artifacts, zero denominators, inconsistent intervention or duration
math, clock gaps, incomplete cleanup, checksum changes, unsigned evidence and an
attestation key that does not match the externally preserved runner fingerprint.

## Claims and unresolved gates

An offline pass proves integration mechanics only. A live controlled pass shows that the
reported model and profile completed this bounded disposable scenario for the recorded
real duration. Each failed or cancelled run remains explicit and retains its partial
checkpoints.

This tier does not resolve the soak's three numeric release contracts: detailed runtime
state caps, append-cost flatness, and resident-memory bounds remain
`not_evaluated` until the release owner approves a versioned policy. It also does not
justify “99% unattended”; that population claim needs preregistered sampling and
confidence rules. Report the observed rate, sample size, duration, stalled work and
interventions without extrapolation.
