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
Recovery JSON is retained and hashed even when that subprocess exits unsuccessfully.

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

## Verify retained or copied source evidence

Obtain the exact source SHA and package version from the reviewed PR/commit or
qualified candidate, independently of the bundle you are checking. Replace the
three values below with that trusted identity and the retained directory:

```sh
node scripts/maintainer-drill.mjs --verify=EVIDENCE_DIR --expected-revision=SOURCE_SHA --expected-version=PACKAGE_VERSION
```

This read-only command executes no recorded command and accesses only fixed
bundle filenames. It checks the receipt digest, each raw output/report's digest
and size, successful subprocess exits, the two prescribed commands, the raw TAP
summary, and all four exact recovery suites/assertions. It rejects partial/failed
receipts, stale revision/version, changed commands, incomplete assertion counts,
missing human/release gaps, linked files and oversized evidence. Exit 0 returns
`verified-source-rehearsal`; an error exits 1.

Copied Windows receipts can be checked on another OS: serialized source paths are
interpreted using their original platform and never opened. Earlier v1 receipts
that omit `sourceRoot` remain readable by inferring the common root from a known
suite suffix, then checking all four paths under it.

Checksums establish byte integrity and internal consistency. They are not a
signature from a trusted runner, evidence of a human's independence, or acceptance
of an installed release. Retain the trusted run/commit provenance and independent
observer record alongside the bundle. Every successful verification still reports
the human, installed-artifact and elapsed-observation gates as pending.

## Consumer-installed baseline probe

This optional networked command installs a pinned published npm artifact into a
fresh consumer directory and exercises the real loopback HTTP flow/backup/restore
routes. It requires the clean committed source checkout and local dependencies
above. It performs no build, publication or provider call. Coordinate its install
and server with the epic's resource owner; Windows x64 is the exercised profile.
Other platforms require their own retained run before claiming acceptance.

Obtain version, npm SHA-512 integrity and source revision independently from the
reviewed release metadata/provenance. The command verifies the tarball bytes and
installed manifest. The source revision is an operator-supplied declaration;
provenance signature verification remains with Engineering's release gate.

For the published 3.46.2 baseline (source `320347356891aa1c24e0f2f9ce12719317e58bde`):

```sh
node --test scripts/maintainer-installed-baseline.test.mjs
node scripts/maintainer-installed-baseline.mjs --version=3.46.2 --integrity=sha512-QIX1FBKDQvIZBGI6TVx7rHBHlO/FyobSTgop+RhaYwvtBiq4hqbZNqf7ytQYcjExBScZ5fn6Art4sJeZMs3lqQ== --source-revision=320347356891aa1c24e0f2f9ce12719317e58bde
```

The default npm CLI is `node_modules/npm/bin/npm-cli.js` beside the Node executable.
If your Node installation places it elsewhere, add
`--npm-cli=ABSOLUTE_PATH_TO_NPM_CLI_JS`. Commands use Node directly without a shell.
Consumer install scripts are disabled, npm's user/global configuration files are
separate and empty, and the cache/home/data/temp/tool roots are disposable. The
application tarball is pinned; transitive dependencies resolve at install time.
Retain `consumer/package-lock.json` to identify the graph actually exercised.

The probe confirms the responding install/data root before any mutation. It
creates a synthetic empty flow, checks its backup contains the expected record,
changes the flow, rejects an archive missing required metadata without changing
the record, restores the valid archive, and compares id/name/nodes/edges. Response
bytes, archives, logs, lockfile and SHA-256 receipts remain in the printed
`flujo-maintainer-installed-*` directory, including on failure. The receipt binds
the tool's clean Git SHA separately from the declared artifact source SHA.

Cleanup targets only processes launched by the probe. On Windows it forcibly
stops the owned process tree; on other platforms it signals the owned process
group. It records launcher exit and checks that the selected loopback port closed.
These observations do not prove graceful cleanup or every descendant's generation;
Production #547 supplies that contract. Preserve failed cleanup as failed evidence.

`passed-baseline-probe` proves this synthetic installed baseline scope. It does
not complete the candidate upgrade, fresh-root recovery, security/access tabletop,
independent human operation or elapsed continuity requirements below. Every receipt
keeps those gates pending; the source-bundle verifier above does not validate this
different receipt kind. Checksums establish consistency, not trusted signatures.

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
