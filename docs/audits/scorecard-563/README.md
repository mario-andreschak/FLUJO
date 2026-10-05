# Scorecard #563: acceptance contract and evidence ledger

This is the proposed contract for [#564](https://github.com/mario-andreschak/FLUJO/issues/564)
and the claim-reconciliation portion of [#578](https://github.com/mario-andreschak/FLUJO/issues/578).
The outcome is **all nine original dimensions independently reassessed at A- or better**.
Implementation, a successful validator, and test counts do not award a grade.
Maintainer/reviewer agreement, named human responsibility, installed release acceptance,
human observation and external reassessment are pending.

The complete [published plan](https://github.com/mario-andreschak/FLUJO/issues/563#issuecomment-5973430942)
remains the parent contract. No local-only substitution for the shared/public profile
is accepted here. A proposed profile/threshold reduction needs an explicit separately
reviewed contract change; version 1 rejects it. Persona exclusions may remain
experimental only with explicit independent acceptance and visible limits.

## Files and reproducible checks

- [scorecard.json](scorecard.json) is the maintained contract, proposed budgets,
  profile matrix, revision/artifact/evidence ledger, issue reconciliation and open gates.
- [scorecard.schema.json](scorecard.schema.json) is its versioned JSON Schema.
- [baseline snapshot](evidence/baseline-2026-10-03.json) retains public GitHub/npm
  observations and the last three issue comments at capture.
- [source observation](evidence/source-observation-2026-10-03.json) retains exact
  main-source blob hashes and excerpts for the existing #520 fixes and the
  #517 tool-refresh/prefill behavior that was unintegrated at that capture.
- [draft proposal snapshot](evidence/proposals-2026-10-03.json) retains exact
  PR #579–#587 head/base SHAs and public descriptions at its capture time.
- [fresh dependency audit](evidence/npm-audit-2026-10-03.json) retains the
  failed planning lockfile observation, separately from September's clean audit.
- [dependency remediation observation](evidence/dependency-remediation-59b65de8.json)
  retains the coordinator's clean PR #600 audit payloads, exact source blobs and
  a separate independent replay whose source-binding capture failed during integration.
- [hosted candidate CI observation](evidence/hosted-ci-b8cf905f.json) binds the
  published `b8cf905f` tree to its executed merge, downloaded audit archive and
  actual job results. The Ubuntu development-inclusive audit reports zero findings;
  Windows production and overall verification failed. The source dependency gate
  remains pending for selected-release/profile qualification; the build gate is failed.
  Historical failures, producer reports and the rejected replay remain retained.
- [npm content inspection](evidence/npm-content-inspection-3.46.2.json) retains
  verified tarball digests, decoded subject comparisons and shipped manifest/build
  identity, with signature and installation checks explicitly unperformed.
- [artifact producer contract](artifact-acceptance.md) defines the separate
  witness/artifact digests, required source/runtime checks and per-platform/method
  evidence needed for installed acceptance.
- [publication reconciliation](publication-reconciliation.md) maps eleven concrete
  publication claims to a checksummed twelve-document source inventory, existing
  qualifications, topic owners and pending candidate-release acceptance.
- [publication checker](../../../scripts/check-scorecard-publication.mjs) inventories
  exact committed guide bytes and checks parsed local file targets in that tree.
  [Invocation and limits](publication-reconciliation.md#repeat-for-the-actual-release)
  keep this source check separate from claim coverage and installed acceptance.
- [historical failed soak](evidence/2026-09-16-persona-soak.json) is a byte-preserved
  copy of the existing public audit payload. Evidence-directory attributes disable
  Git line-ending conversion so hashes identify the same bytes on Windows and Unix.
- [validator](../../../scripts/validate-scorecard.mjs) checks structure, complete rows,
  references, local SHA-256 payloads, source/artifact/profile correspondence, windows,
  protected Persona contracts and truthful claim promotion.
- [boundary tests](../../../scripts/validate-scorecard.test.mjs) exercise rejected
  claims, altered evidence, missing profiles, simulated live evidence and closure semantics.

Run from the repository root with Node >=22; no dependency installation is needed:

```sh
node scripts/validate-scorecard.mjs
node --test scripts/read-scorecard-evidence.test.mjs scripts/validate-scorecard.test.mjs scripts/check-scorecard-publication.test.mjs
node scripts/validate-scorecard.mjs --closure
```

Exit 0 from ordinary validation means a valid ledger, which may be incomplete.
Exit 1 means malformed/inconsistent records, unavailable evidence or checksum failure.
Exit 2 from `--closure` means declared acceptance gates remain open.
Every `observedAt` must be at or before the validator's current UTC wall clock.
An elapsed window must have ended by that observation; future dates cannot establish
completed human or live observations. The CLI has no clock override. Synthetic API
tests use an explicit test clock to check admission rules, not to establish elapsed evidence.
API results retain `validationClock` with epoch milliseconds and `wall-clock` or
`override` provenance; CLI output prints its effective wall clock. Retained validation
receipts should include these fields. A historical receipt without them cannot be
retroactively described as having reported clock provenance.
File-read or JSON-parse failures precede API validation and emit no clock line.
The validator never downloads remote artifacts, calls models, changes accounts,
starts runtimes, performs releases or changes repository settings.
Its small documented schema vocabulary fails closed on unsupported keywords.
The published schema can also be consumed by a draft-2020-12 JSON Schema tool;
cross-record/evidence rules still require the repository validator.

## Verified dated baseline

The original audit assesses `d68492712315d30c856c8d2ba95b0a26a859bd18`.
On October 3, 2026, fresh fetch and remote-main comparison identified
`3511ba49514fe8cf525f5a22c16c3806bf3886ba`, source package version 3.46.2.
The public API reports verify run 37129765836 attempt 1 passed at that source SHA.
Artifact IDs/digests are retained, but their test payloads were not downloaded/revalidated
by this slice. A source version and CI metadata are not installed-release acceptance.

The 3.46.2 tag resolves to `320347356891aa1c24e0f2f9ce12719317e58bde`.
npm reports the 3.46.2 package's SHA-512 integrity and provenance URL, with no
`gitHead` in the captured response. GitHub reports the Windows installer's SHA-256.
Package and installer contents were not installed or checked against compiled source.
No immutable container image digest was captured. These remain distinct ledger entries.

The subsequent npm inspection downloaded and hashed the actual 3.46.2 archive.
SHA-512 agrees with registry integrity and both decoded attestation subjects;
SHA-256 is `470605df68d8d2afb1db4895ec3d51e2be1a4d0ba93805becad86733ae71135c`.
Its manifest identifies version 3.46.2 / Next 16.3.5 and build
`EKDYzpGxkbGh7LjwGF_Ru`. Decoded provenance declares the same `3203473`
release source. Signatures/issuer/inclusion policy were not verified, and no package
installation or runtime was executed; the ledger retains observed-metadata status.

At the later 22:06 UTC capture on October 3, PR #579–#587 were unmerged drafts.
Their exact head pins are source proposals, not shipped behavior or independently
verified test results. #517/#526 have the #585 proposal, and #547 has #580;
their issue-reconciliation entries retain the previous baseline and remaining
installed acceptance. Captures are immutable historical observations: a later
push or integration needs another evidence entry rather than relabeling these pins.

The new lockfile audit returned exit 1 with 10 affected packages: 8 high,
1 critical and 1 moderate. It ran at Docs PR revision
`21e946e1e6b1114816d5c232ca3768bd06bcca31`; the lockfile Git blob SHA-256
`9201a840c73f7dfcf2e55d9e31fa1107857084e4783ce9fa5dd829c66bb40d58`
is identical to planning main `3511ba4`. Affected-package counts are not
unique advisory counts or an independent threat-model severity assessment.
The failed dependency gate stays visible for the planning baseline. The coordinator's
[PR #600](https://github.com/mario-andreschak/FLUJO/pull/600) at
`59b65de81b52db2e29cde2d5848436661d04e631` reports production/development-inclusive
audits returning zero findings. Both retained raw payloads have SHA-256
`1866e25b30b3c684a069e7cfac3698a9b799a04fd0d539e199d21f16c31467e2`;
Docs reverified their bytes and source blobs, with execution/source association
producer-reported. The independent lockfile replay also returned zero findings,
but a later identity check found concurrent integration, so that capture cannot
qualify a source SHA. Its failed binding and raw output remain retained. Integration,
final CI/build and the assessed release audit remain pending; neither candidate nor
historical clean results qualify an untested release.

The September 16 offline failure stays checksummed and attributed to its synthetic
source snapshot: 560 completed Activities, 12/13 criteria passing, one append p95
169.6893 ms against strict <150 ms, **overall failed**. Later #418/#505 reported
automated passes at an older identified implementation, including rollback/restoration
history. They do not erase this failure or demonstrate current-release equivalence,
28 elapsed days, independent human usability or public-world autonomy.

## Nine retained rows

All targets below are proposals for agreement. Accountable human names are unset;
topic owners route delivery, while the maintainer must accept the human assignments.

| Dimension | Original | A- evidence required | Delivery owner / issues |
| --- | --- | --- | --- |
| Idea / product fit | A- | Repeated independent use, eight-week retention and uncoached novice outcomes | Product fit; [#572](https://github.com/mario-andreschak/FLUJO/issues/572), [#577](https://github.com/mario-andreschak/FLUJO/issues/577) |
| Feature surface | A- | Retained advertised journeys on installed artifacts, full 128-tool reachability and usable failures | Feature surface; [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#572](https://github.com/mario-andreschak/FLUJO/issues/572), [#578](https://github.com/mario-andreschak/FLUJO/issues/578), [#517](https://github.com/mario-andreschak/FLUJO/issues/517), [#526](https://github.com/mario-andreschak/FLUJO/issues/526) |
| Engineering discipline | B+ | Enforced review/check gates, verifiable distributions and human release responsibility | Engineering; [#564](https://github.com/mario-andreschak/FLUJO/issues/564), [#565](https://github.com/mario-andreschak/FLUJO/issues/565), [#576](https://github.com/mario-andreschak/FLUJO/issues/576) |
| Code health | B- | Owned module/behavior contracts, enforced boundaries and second-human maintenance | Code health; [#571](https://github.com/mario-andreschak/FLUJO/issues/571), [#576](https://github.com/mario-andreschak/FLUJO/issues/576) |
| Security | C+ | Scoped ingress, safe migration/transfer, enforced MCP isolation and independent threat-model review | Security; [#565](https://github.com/mario-andreschak/FLUJO/issues/565), [#566](https://github.com/mario-andreschak/FLUJO/issues/566), [#567](https://github.com/mario-andreschak/FLUJO/issues/567), [#568](https://github.com/mario-andreschak/FLUJO/issues/568), [#573](https://github.com/mario-andreschak/FLUJO/issues/573), [#574](https://github.com/mario-andreschak/FLUJO/issues/574), [#575](https://github.com/mario-andreschak/FLUJO/issues/575), [#101](https://github.com/mario-andreschak/FLUJO/issues/101), [#527](https://github.com/mario-andreschak/FLUJO/issues/527) |
| Maturity / stability | C | Original-workload confirmation, resource/fault budgets, stable tools and unchanged Persona gates | Maturity; [#569](https://github.com/mario-andreschak/FLUJO/issues/569), [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#572](https://github.com/mario-andreschak/FLUJO/issues/572), [#578](https://github.com/mario-andreschak/FLUJO/issues/578), [#520](https://github.com/mario-andreschak/FLUJO/issues/520), [#515](https://github.com/mario-andreschak/FLUJO/issues/515), [#517](https://github.com/mario-andreschak/FLUJO/issues/517), [#526](https://github.com/mario-andreschak/FLUJO/issues/526), [#505](https://github.com/mario-andreschak/FLUJO/issues/505), [#435](https://github.com/mario-andreschak/FLUJO/issues/435) |
| Community / bus factor | D | Sustained independent contributors/users and trained human backups | Community; [#576](https://github.com/mario-andreschak/FLUJO/issues/576), [#577](https://github.com/mario-andreschak/FLUJO/issues/577) |
| Docs honesty | A | Release-bound consistent claims, preserved failures and visible support/experimental limits | Docs; [#564](https://github.com/mario-andreschak/FLUJO/issues/564), [#565](https://github.com/mario-andreschak/FLUJO/issues/565), [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#578](https://github.com/mario-andreschak/FLUJO/issues/578) |
| Production-readiness | C- | Installed operation/recovery plus authenticated multi-user isolation/sharing | Production; [#566](https://github.com/mario-andreschak/FLUJO/issues/566), [#567](https://github.com/mario-andreschak/FLUJO/issues/567), [#568](https://github.com/mario-andreschak/FLUJO/issues/568), [#569](https://github.com/mario-andreschak/FLUJO/issues/569), [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#573](https://github.com/mario-andreschak/FLUJO/issues/573), [#574](https://github.com/mario-andreschak/FLUJO/issues/574), [#575](https://github.com/mario-andreschak/FLUJO/issues/575), [#578](https://github.com/mario-andreschak/FLUJO/issues/578), [#553](https://github.com/mario-andreschak/FLUJO/issues/553), [#547](https://github.com/mario-andreschak/FLUJO/issues/547), [#212](https://github.com/mario-andreschak/FLUJO/issues/212) |

## Deployment profiles and autonomy

The machine-readable OS/install matrix distinguishes documented availability from
verified release acceptance. None of its current platform/install rows is marked verified.

| Profile | Present declaration | Required acceptance |
| --- | --- | --- |
| Local single-owner | Current default envelope: one trusted operator, loopback, host-side MCP privileges; logical workspaces | Windows installer/npm/source; Linux npm/source/container; macOS npm/source journeys, external provider/tool prerequisites, scoped ingress, credential migration and MCP enforcement |
| Authenticated persistent worker | Gated proposal, Linux container/service and Windows native-service matrices | Separate worker bearer/identity, proven local schedule opt-in, copied schedules suppressed, process receipts, health/audit/resources, coherent backup/restore and versioned consumer contracts |
| Shared/public | Gated proposal, hardened Linux service; original objective retained | #573 architecture, #574 individual isolation, #575 team share/revoke/edit conflicts, credential/process/storage boundaries, authenticated ingress and independent threat-model/installed operator acceptance |

Provider credentials/subscriptions/quotas, compatible local models and tool-specific
git/Python/uv/browser/OS requirements are explicit prerequisites. Account provisioning
time and failures must be recorded separately. Authentication, snapshots, SDK history,
streams, worker identity and UI provenance/freshness need versioned compatibility
agreements from FACTORY, O, brain-online and the UI owners. Original/current identity,
digest recipes, dedicated bearer versus owner session, uncertainty observation and
startup/COMMIT/transport fences remain distinct. A sealed source witness cannot authorize
spending, migration capture, account adoption, replay or cleanup.

Autonomy is separately gated: an offline simulation, short genuine-model test or
successful process restart cannot establish useful public-world work or multi-week
unattended success. The proposed acceptance spend envelope is undeclared: no numeric
limit or concrete model/account scope is recorded here. Development/push/deployment
authorization is separate; the coordinator owns the deployment candidate. A dollar
CLI argument is not monetary enforcement.

## Numeric contracts before measurement

Every budget has an owner, status, metric/operator/limit/unit, denominator, observation
window, declaration time and basis. Its structured observation contract specifies
the real/virtual clock, minimum elapsed/simulated duration and minimum denominator.
Agreement evidence is required before changing
a proposal to agreed. Historical evidence remains under its original contract;
capturing a contract today does not retroactively predeclare it for an older run.
Passing acceptance must reconcile these bounds and retained agreement must predate
measurement. Success-rate metrics retain an integer numerator and denominator;
timeless labels or rounded percentages cannot stand in for counts.
Metric denominators and count-valued metrics, including bytes and interventions,
must be whole numbers. All current budget units are bound by the versioned
`metricUnits` map; `unitKinds` declares integer, continuous, ratio or duration semantics
and duration conversion. Relabeling a unit cannot reinterpret a numeric target or
disable its checks. This does not ratify the proposed numeric targets. Any recorded
non-null start must be valid UTC. Any retained end on an instant/simulated window must be
valid UTC, no later than observation and no earlier than a known start. It does not
turn virtual days into elapsed days. `simulatedDays` is virtual duration, so 28.5 days
may exceed the unchanged 28-day floor; it cannot substitute for the required integer
daily checkpoint denominator or actual runner coverage.

Passing checksummed metrics against agreed or existing contracts require an actual
UTC measurement start, no earlier than declaration and no later than observation.
Simulated days remain simulated. Existing Persona limits and their 28 daily append
checkpoints / 20 recall-search denominators require a separately reviewed contract
version to change. A proposed null monetary limit records a missing acceptance
contract; it does not revoke the user's development/deployment authorization.
Production claims cover all three profiles, and Engineering, Docs and Maturity
claims retain a required candidate-build gate.

| Contract | Preserved or proposed target | Denominator/window |
| --- | --- | --- |
| Existing Persona soak | Daily append p95 <150 ms; peak RSS <=768 MiB; final RSS growth <=256 MiB; final-seven append median <=2× max(first-seven median,20 ms) | Exact-revision 28×20, seed 459, learning; every day's raw samples |
| Existing Persona collections | <=1,248 records per detailed kind; daily uncompacted mailbox <=500, Activities/dispatches/pins <=200 each; lease history <=50 | Every checkpoint/sweep; missing/new uncontracted kinds fail |
| Existing full recall | p95 <150 ms plus full-candidate/ranking checks | 50,000 items / 20 controlled searches |
| Proposed ordinary runtime | Peak RSS <=1 GiB, retained growth <=128 MiB, <=4 active lanes from 8 queued | 24 elapsed hours on declared Node 22 Windows/Linux 2-CPU/2-GiB runner; parent >=2 MB, children <=5.6 MB; byte/media/paused/archive admission limits need #569 ratification |
| Proposed recovery/backup | RTO <=120 s; zero lost accepted durable records; zero duplicate verified effects | 10 graceful +10 forced restart trials and 10 backup/restore trials per claimed OS/install profile; unknown effects remain unknown |
| Proposed security | Zero accepted unauthorized matrix operations; zero unresolved high/critical findings | All declared session/token/CSRF/owner/process/export/share/revoke rows; skipped/missing rows block |
| Proposed product evidence | 10 independent weekly users for 8 weeks; >=8/10 novices finish <=15 min without coding/live coaching | All enrollment, provisioning, missing/drop-off outcomes retained |
| Proposed continuity | 2 additional human maintainers; >=3 substantive non-author humans | Independent review/release/recovery drills; 90 elapsed days of contributions/reviews |
| Proposed live stages | Authorized 1-hour smoke then 7 elapsed days; 28 elapsed days for multi-week claim; >=99% verified due rounds, zero unscheduled interventions/duplicate effects | All due rounds including missed/stalled/rejected/failed, useful output-quality review, scheduled controls separate, authorized enforced spend accounting |

These proposals are coordination inputs, not current performance guarantees.
Security, Maturity, Production, Product fit and Community must ratify the workload,
matrices and targets with the maintainer and independent reviewer before measuring.
Do not reduce thresholds/workload because host capacity is low; schedule checks instead.

## Adding evidence and reconciling claims

1. Retain failures before adding later results. Add immutable IDs rather than replacing
   a historical verdict. Refresh dated source/issue observations when integrations change.
2. Record exact SHA, owner, profile IDs, environment/provider/tool versions, commands,
   result, raw payload location/SHA-256, limits, metrics/positive denominators and real
   versus simulated windows. Local payloads must remain inside the repository, including
   resolved symlink targets. Use metadata-only external pointers for payloads not reverified.
   Metrics require a nullable numerator; ratio evidence supplies actual integer counts.
3. Record each npm/image/installer identity separately. Set verified-content only after
   retaining an [artifact producer report](artifact-acceptance.md) with matching
   content hash, exact source correspondence and installed acceptance for its actual
   platform/method rows. The report's checksum differs from the artifact digest.
   Tags, API checksums or successful source builds alone leave content acceptance pending.
4. Change a gate/claim only after the required passing checksummed evidence matches its
   revision, artifact, profile, evidence kinds and agreed budgets. Source-supported is
   limited to source scope. Report-only observations cannot qualify release-supported.
   A release-supported claim needs qualifying evidence for its source at every declared
   profile of each required source/runtime gate. Older passing results can remain in
   that gate's history but cannot qualify the new source. A completed reassessment binds
   supported claims and passed source/runtime gates to its selected release SHA.
   External rubric/consumer agreements may predate a release; their policy applicability
   and current consumer pins still need explicit review.
   Retain scanner coverage and filters with results: zero alerts in a PR's changed
   lines cannot establish a clean repository or release. Reconcile the full selected
   release's findings and installed matrix using the
   [scanner coverage rules](artifact-acceptance.md#scanner-coverage).
   Version 1 retains the primary claim IDs, original dimension/profile subjects, and
   minimum budget/kind/gate bindings in the schema's `acceptanceContract` data.
   Original A- primary claims cannot become experimental exclusions. Removing or
   replacing a claim cannot detach novice, adoption, maintainer, recovery, runtime
   or Persona measurement requirements.
   Additional criteria remain allowed; replacing these minimum contracts needs a
   separately reviewed contract version. Experimental Persona status keeps its
   declared future acceptance requirements visible without claiming measurements.
   Human and live metrics require human-study and live-provider carriers respectively;
   required kinds elsewhere in the claim do not qualify measurements on other records.
   Runtime/recovery/backup metrics require installed-artifact carriers; duplicate effects
   may also be measured by live-provider records. Security metrics require security-review
   or independent-assessment carriers. A source check may record real CI duration but
   cannot supply these protected installed/runtime metrics.
   The ten existing Persona soak metrics require offline-simulation carriers;
   the separately controlled recall benchmark permits offline-simulation or source-check.
   A source-check recall measurement must retain an actual elapsed window; an instant
   source observation cannot qualify. New budgets may be recorded as proposals, but
   agreement and passing checksummed measurements need explicit reviewed unit,
   unit semantics and carrier contracts. An unmeasured proposal may remain pending
   without these contracts. Unknown unit semantics fail closed for acceptance.
   Recall has no new minimum wall duration: its original controlled corpus/search
   coverage and p95 ceiling still need actual runner evidence and topic-owned validation.
   A source observation declaring 28 virtual days cannot supply a Persona soak metric.
   Published human targets and observation floors remain protected, and duration
   measurements cannot exceed the actual elapsed evidence window. Review schema,
   ledger and validator together as described in the
   [contract versioning rules](artifact-acceptance.md#acceptance-contract-versioning).
5. Keep paid/live account work, independent humans, manual accessibility/recovery,
   cross-stream contracts and independent reassessment pending until their owners
   provide actual evidence. No bot/test count can satisfy those gates.
6. At reassessment, record the identified independent reviewer, the selected release SHA,
   verified artifact IDs, retained review, nine grades/rationales and explicitly accepted
   experimental claims. Below-A- grades or disagreements keep the epic open.

A checksum proves file correspondence, not that an author is independent or an experiment
was honestly conducted. Human identity, review authenticity, complete coverage and useful
outcomes require external review; the validator checks declarations and consistency.
It does not substitute for any topic's artifact-specific validator or trusted live authority.

Before final documentation publication, use the ledger to reconcile README product claims,
project-status maturity/support, CHANGELOG release/migration notes, SECURITY.md threat model,
and the topic-owned architecture/API/operations guides. Docs owns this scorecard directory
and validator. Security owns SECURITY.md/security behavior; Engineering owns CI/release;
other topics own their feature/architecture/operations guides. The
[publication reconciliation](publication-reconciliation.md) retains source-era findings
and candidate wording for their review. The foundation changed project-status; later
publication changes have their own source receipts. The actual release needs a fresh
inventory and claim reconciliation after integration.
