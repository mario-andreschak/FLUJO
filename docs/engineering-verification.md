# Local-first qualification and main integration checks

Bundle implementation changes and qualify them locally before pushing. Run `node scripts/verify-local.mjs --install --full` with a supported Node runtime. This installs once, builds once, validates release inventory, runs critical regressions, typechecks, lints, audits dependencies, exercises packed artifacts and runs the ordinary full suite with its assertion baseline. Add `--isolated` only after preparing the existing Docker/process/browser dependencies. Use `--tests-only` to reuse already built local artifacts; it does not claim a fresh build.

Active main ruleset `24434701` still requires twelve genuine GitHub Actions checks and CodeQL high/critical findings protection. The current account has no administrator permission. The compatibility bridge in `verify.yml` therefore runs real production/release checks, source and MCP types, lint, ordinary and isolated suites, workflow contracts, dependency audit, and two extended CodeQL scans before the fail-closed `verification` aggregate. Publication verifies every required job from the latest successful exact-main-SHA attempt. No status-only substitutes or repository-policy bypasses are used.

Automatic verification runs only for PRs targeting `main` and pushes to `main`; intermediate feature branches remain locally qualified. The Ubuntu production job builds once on verified official Node 24.21.0 with the default heap, then exercises the same packed artifacts on the four declared runtime profiles. Release safety still covers Ubuntu and Windows. Explicit `verify-full.yml` dispatch retains the additional Windows production qualification; it is not automatically triggered alongside integration checks. Installer, Worker candidate image, Persona acceptance and scorecard workflows remain manual/release-only.

Critical backend and rendered interface suites remain explicit fail-on-error steps and shared local-runner constants. The ordinary/isolated full suites retain their existing completed-assertion and quarantine baseline gates. Docker isolation setup retries bounded pulls from Docker Hub and public ECR using the identical pinned Node manifest digest; it fails if neither registry supplies it and publishes only the inspected immutable image identity to the probes. It does not skip isolation when the registry fails.

Read-only reconciliation on October 9, 2026 found advanced CodeQL result uploads and processing succeeded for exact main `8a39263282dd7c4d765a7371f09bd79129851425` in run `37997014991`; both language analyses were fresh. The default-setup settings API remained unauthorized, so its setting was not directly verified. That run failed on an ECR `toomanyrequests` image pull, followed by the aggregate refusing its failed prerequisite. Candidate scans and all genuine required checks must still pass on the reconciled integration source before merging.

The ruleset template now matches the existing twelve required contexts, scanner protection, zero human approvals, resolved review threads and strict freshness. Source files do not change active settings. A future switch to one focused hosted check still requires an authorized administrator to reconcile policy and source together; this bridge does not claim that transition has occurred.

## Historical broad qualification recipe

The following records earlier qualification and administrator recipes. Historical permissions, approval settings, observations and runtime pins below are not fresh state; use the current compatibility bridge and observations above.

# Verification and repository enforcement (#565)

Source checks, repository settings, distribution acceptance and human review are
separate evidence. This change does not award a scorecard grade or authorize a
merge, release, deployment, provider run or live controller operation.

## Source contract

`scripts/verification-contract.mjs` lists the required jobs and displayed check
names. `verify.yml` runs on every PR and main push; its final `verification`
check runs even after failure and rejects any missing, failed, cancelled or
skipped prerequisite. One Ubuntu production job on Node 22.23.3 (matching the
container) builds once with the normal Node heap, typechecks MCP workspaces,
validates release payloads and installs the
packed app/MCP tarballs into a disposable consumer before exercising actual
process boundaries. Browser/operator journeys remain separate release gates.

The ordinary/isolated test baseline continues to require completed assertions,
fresh reports and approved skip/quarantine accounting. A Jest exit is tolerated
only until that mandatory baseline check evaluates its actual report.

Release publication still requires the authoritative `verify.yml` workflow,
exact main-push SHA and successful latest run. It additionally checks every
required job in that run's current attempt, checks run identity again, and
refuses a newer failed run. If a partial rerun omits earlier successful jobs
from current-attempt evidence, rerun **all verification jobs**; do not reuse an
older attempt to bypass this contract. Original npm candidate bytes, integrity,
version/tag checks and OIDC publisher identity remain enforced.

Direct action references are pinned to full upstream commit SHAs. Dependabot
opens reviewed weekly action/npm update PRs; this file alone does not enable
Dependabot alerts. Workflow tokens default to read-only or no permissions;
jobs declaring writes require review. CodeQL has only source/actions read and
security-results write permissions. Privileged publisher/installer jobs retain
their existing separately scoped authority pending the distribution slice.

## Scanner coverage and current blockers

The dependency job audits the installed lockfile including development/build
dependencies, preserves the JSON report, and fails at high/critical severity.
CodeQL scans JavaScript/TypeScript and GitHub Actions with `security-extended`
queries on the candidate source. Scanner success is not a threat-model review,
an OS sandbox, a clean installed-consumer dependency graph or proof of absent
secrets. Secret detection/push protection must be verified in repository
settings. Vulnerability response/private reporting belong to `SECURITY.md` and
the Security topic; their human tabletop is still required.

Read-only observations on October 3, 2026, against main
`3511ba49514fe8cf525f5a22c16c3806bf3886ba`:

- Effective main rules: empty. Visible ruleset `18583448`: disabled.
- Current token: push/triage/pull, without admin or maintain permissions.
- Latest returned CodeQL analyses: August 2, source
  `d5f3b47d82b0ceca6644d20e71e8164436a35009`, not the candidate revision.
  The alerts endpoint's first page returned 10 open alerts (1 critical,
  8 high, 1 medium); triage/reassessment of fresh scans is required.
- CodeQL default-setup inspection: HTTP 403 (mode unverified).
- Dependabot alerts: HTTP 403 explicitly reporting disabled alerts.
- Secret-scanning alerts: HTTP 404; availability, settings and coverage unknown.
- Fresh local npm audit of the baseline lockfile: failed, with 10 affected
  packages (1 critical, 8 high, 1 moderate). Preserve the report and coordinate
  dependency fixes; this gate deliberately remains red until resolved.

## Administrator configuration

An administrator must review and apply
`.github/rulesets/main-verification.json`. It is a proposed API payload,
**not evidence that the rules are active**. It requires one independent
approval, stale-approval dismissal, code-owner review, last-push approval,
resolved threads, up-to-date checks from GitHub Actions app `15368`, CodeQL
high/critical findings protection, no force pushes/deletion, and an empty
bypass list. The app ID was observed on baseline check runs; reverify it.
`CODEOWNERS` routes privileged code to the current human maintainer. Human
backup consent/training and independence remain #576 gates; no bot counts as
an independent human reviewer.

Before enabling the new CodeQL workflow, inspect Settings > Advanced Security
and switch from default setup to advanced setup if default setup is enabled.
[GitHub rejects advanced CodeQL SARIF uploads while default setup is enabled](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/troubleshoot-sarif-uploads/default-setup-enabled).
Retain the fresh JavaScript/TypeScript and Actions analyses for the candidate
SHA and resolve high/critical findings with Security. Enable Dependabot alerts
and secret scanning/push protection where available, record exceptions and
recheck their APIs. A successful CodeQL job does not by itself block findings;
the [code-scanning ruleset rule](https://docs.github.com/en/rest/repos/rules)
supplies that enforcement.

After applying settings, run `node scripts/verify-repository-rules.mjs main`
with administrator read access and retain its JSON and checksum. This read-only
auditor fails if effective rules are absent, a bypass list is hidden/nonempty,
a required check is unbound to its app, review is weak, or finding protection
is missing. Its success proves configuration only; run the denial drill below.

Protected main disallows the current CLI's direct version-commit push. Prepare
the synchronized version in a reviewed PR, then dispatch the existing
`publish-npm.yml` on main with the **merged exact SHA** and synchronized version.
Do not exempt the publisher bot from review/checks to retain the old push path.
CLI preparation ergonomics and trained release owners remain separate work.

## Disposable merge-denial drill

Run after the candidate is integrated and an administrator has agreed the
policy. This recipe does not attempt a merge into main.

1. Create a disposable base branch `codex/gate-probe-base-<unique-id>` from the
   candidate. The administrator applies a temporary copy of the exact main
   ruleset targeting this branch, with no actor/bot/admin bypass. Capture the
   effective branch rules and full ruleset, and pass the read-only auditor
   against the disposable base.
2. From that base, create `codex/gate-probe-fail-<unique-id>` in an owned clean
   checkout. Append `test('intentional merge-denial probe', () => assert.fail('expected red gate'));`
   to `scripts/workflow-contract.test.mjs`. Commit/push and open a disposable
   PR against the probe base. Record actor, head/base SHAs, PR and CI run IDs.
3. Wait for `workflow-contract` and final `verification` to fail. Retain the
   logs; record other failures/skips rather than claiming a full passing run.
4. As an ordinary push-capable contributor, record the current base SHA, then
   run `gh pr merge <PR> --repo mario-andreschak/FLUJO --squash --match-head-commit <head-SHA>`
   without `--admin` or auto-merge. Expected: nonzero denial; PR still OPEN,
   base SHA unchanged. Repeat with each bot principal actually used for
   integration, using its separately authorized credentials. No token copying
   or identity substitution is part of the drill.
5. Save command stdout/stderr/exit code, authenticated actor, ruleset/bypass
   state, check names/app IDs, fresh PR state and base ref before/after. A
   successful merge means **failed enforcement**, even if CI was red. Because
   the target is disposable it cannot change main; fix settings and repeat.
6. Remove the intentional failure, require an independent human approval and
   fresh passing required checks, then demonstrate an allowed merge to the
   disposable base. Confirm stale approvals, direct push and force-push rules
   with the administrator's controlled fixture plan. Close/remove disposable
   artifacts only after retaining evidence and agreeing cleanup ownership.

Retain source SHA, OS/Node/npm versions, exact commands, failures/skips,
run/attempt IDs, artifact hashes and human owner in #564/#578's evidence ledger.
The drill, fresh scanner/remediation evidence, installed-release acceptance,
human security/release tabletop and independent reassessment remain open.

CI pulls the pinned Node image from Docker's public ECR mirror to avoid Docker Hub's anonymous pull limit. Both the container index and Linux isolation image retain their original SHA-256 digests; the signed Node executable checks remain mandatory. Obsolete Worker image candidate runs are cancelled when a newer commit arrives.

