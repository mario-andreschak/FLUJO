# Disposable maintainer release/recovery drill

This drill has three distinct outcomes: automated source rehearsal, installed
release acceptance, and a human independently operating/reviewing it. A passed
source receipt proves only its fixed fixture scope. It grants no publication,
account recovery, live controller, paid provider or production data authority.

## Automated source rehearsal

Start from a fresh committed clone or your owned clean worktree. Follow
[contributor setup](README.md), finish `npm ci --include=dev`, and keep personal
dotenv/runtime files out of the checkout. No model account or private data is needed.

```sh
npm run test:dependencies
node --test scripts/maintainer-drill.test.mjs
node scripts/maintainer-drill.mjs
```

The runner executes serially:

1. Existing release guard tests for official origin, exact revision, completed
   verification, and rejection of failed/stale/mismatched publication evidence.
   Their release subprocesses are mocked; they do not build or publish a candidate.
2. Four existing recovery suites: link-safe filesystem backup/restore, backup and
   restore route selection, portable snapshot capture, and worker snapshot restore.
   They use synthetic files, temp directories, and mocked service boundaries. They
   exercise real production archive/restore code, including malformed/tampered
   input rejection; they do not launch a consumer-installed application.

The runner creates a new `flujo-maintainer-drill-*` directory in OS temporary
storage and prints its absolute path. It sets a disposable data/identity/temp root
and excludes inherited credentials, worker flags and Node options from child
processes. It never takes an existing data directory as input or deletes your
data. Logs and `receipt.json` remain for inspection. Each raw output and recovery
JSON result has SHA-256, byte size, exact command, exit status and elapsed time;
`receipt.sha256` covers the receipt. Preserve this directory outside ephemeral CI
storage if it is used as evidence. Review it for privacy before sharing.

Green aggregates are insufficient: all four exact recovery suites and every
assertion must complete without skips, todos or pending results. Source must be
clean at both ends and keep the same SHA. Timeouts, missing dependencies/results,
nonzero exits or incomplete assertions fail and retain diagnostics. Each gate has
a five-minute timeout; it stops at the first failure. This is a small targeted
check, not the full release verification matrix.

Recovery selection uses a root-relative `testMatch` plus the four exact file
paths. This avoids Jest's Windows glob escaping of dotted absolute checkout
paths such as `.codex`; the receipt independently requires those same four suites.
On a gate failure `sourceCleanAfter: null` means the final source check was not
reached, rather than claiming the source was dirty.

For dependency diagnosis only:

```sh
node scripts/maintainer-drill.mjs --release-only
```

This produces a **partial** receipt, records recovery as not run and exits 1.
It cannot satisfy the drill. A failed run is evidence of the failure, not permission
to weaken checks or reuse an older green receipt.

## Human operator / observer exercise

A consenting independent human uses the guide on their own disposable machine
or checkout without the original author operating it. Record operator, observer,
source SHA, OS/Node/npm, start/end, setup friction and any intervention in the
[evidence form](maintainership.md#evidence-record). Submit a useful first PR and
review a core change: explain its observable behavior, regression boundary,
compatibility, failure handling and the evidence that would stop its merge.

Run the source rehearsal, inspect the four suites and explain a failure using
their retained diagnostics: a link/path escape, tampered checksum, missing exact
release CI result, and a partial publication. Explain why the safe next step is
inspection/re-verification, and when failed-job-only resume applies. The operator
must locate the relevant production module and existing runbook without hidden
maintainer knowledge. The observer records any inaccurate diagnosis/coaching.

Then conduct the synthetic private security/release tabletop in
[maintainership](maintainership.md#security-and-release-tabletop). Retain decisions
and omissions; a script cannot certify human independence, review quality or
private-reporting/access readiness.

## Installed candidate and upgrade/recovery gate

This gate is **pending** until Engineering #565 and Production #570 provide a
qualified exact candidate and operating recipe for the supported profile. Schedule
heavy validation with the epic coordinator; do not launch it alongside other
topics' full builds/soaks. Use only synthetic data and loopback exposure.

The existing source candidate verification path includes:

```sh
npm run build
npm run validate:mcp-release
npm run smoke:mcp-artifacts
```

The packed smoke installs into a new temporary consumer directory and crosses
the real app/MCP process boundaries. Dependency installation may access the npm
registry; model/provider calls are not part of that smoke. It is not the full
Windows/Linux release gate and does not by itself test an upgrade or production
recovery. Retain raw logs, source SHA, candidate manifest/tarball integrity and
consumer environment separately from the fixture receipt.

For the agreed supported install/profile, the independent operator must also:

1. Install the exact qualified baseline artifact into a disposable root, record
   its source/integrity, create synthetic workflow/conversation/configuration data,
   and verify it can be read. Keep real credentials and external tool effects absent.
2. Follow #570's backup recipe. Record included/excluded data and archive checksum;
   verify it has no personal identity, external-root files or private capture authority.
3. Stop only the drill's owned processes and retain observed shutdown evidence.
   Upgrade to the exact candidate, reopen the synthetic records, and measure the
   prescribed migration/recovery criteria. A saved config is not a successful run.
4. Introduce the agreed disposable failure, restore into another fresh root using
   the approved route, and compare record contents/checksums and readable behavior.
   Test invalid/tampered backup rejection and verify no unintended schedule/tool
   effects run. Copied snapshot schedules stay inactive; #553 owns fenced opt-in.
5. Retain failure/intervention timings, source/artifact identities, process receipts,
   checksums, exclusions and result. Any unsupported recovery or account-access
   step remains a gap. Do not overwrite live data or infer permission from a test.

Do not mark this installed gate complete from fixture results or fabricated
measurements. Supported releases, response targets and actual private channel are
defined by Security #565. Human access verification needs the consenting owner;
90-day continuity needs actual elapsed observations; external reassessment stays
with the independent reviewer. These pending gates are listed in every receipt.
