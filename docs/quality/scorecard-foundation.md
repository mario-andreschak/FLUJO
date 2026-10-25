# Scorecard foundation contract

[Issue #564](https://github.com/mario-andreschak/FLUJO/issues/564) defines the
acceptance contract for the nine dimensions of
[epic #563](https://github.com/mario-andreschak/FLUJO/issues/563).
The maintained [version 2 contract](scorecard-foundation.json) is a definition
and preregistration for future measurements. It awards no grade and qualifies no
installed release. All nine original dimensions still target an independent A−
or better assessment; shared/public hosting and autonomy remain separate required
capabilities.

## Automated development responsibility

The user changed the development policy on October 25, 2026: development is fully
automated, with no human review, approval or answers. The
[recorded policy update](https://github.com/mario-andreschak/FLUJO/issues/564#issuecomment-6395012416)
supersedes the earlier development wait for human assignments or sign-off.

Each of the nine delivery roles has an identified automation owner in the
contract. That owner maintains the definition, preregistration and honest evidence
collection. A separately identified GPT-6.1 Sol agent performed the
[independent automated source review](https://github.com/mario-andreschak/FLUJO/issues/564#issuecomment-6395160004).
The contract records its actual evidence reference, identity, model and reasoning
effort. The [foundation checker](../../scripts/check-scorecard-foundation.mjs)
remains a mechanical preservation and completeness verifier. Neither automated
review, that checker nor an automated maintainer decision is an independent human
opinion or an external scorecard assessment. No human approval is claimed or
awaited for development.

Human/community targets still require actual people and elapsed observations.
Bots cannot be counted as independent users, novice participants, contributors or
backup human maintainers. Missing observations stay missing. Development policy
does not turn a definition into achievement of the defined outcome.

## Criteria and supported-profile definitions

The contract retains the original baselines, grades, proposed criteria, required
evidence kinds and linked work for these separate rows:

| Dimension | Original grade | Principal acceptance work |
| --- | --- | --- |
| Idea / product fit | A− | Independent use and first-use outcomes; #572, #577 |
| Feature surface | A− | Installed model/MCP/graph/debugger/automation/API journeys; #570, #572, #578 |
| Engineering discipline | B+ | Verification, provenance and vulnerability response; #565, #576 |
| Code health | B− | Module boundaries and demonstrated maintainability; #571, #576 |
| Security | C+ | Authentication, private credentials, enforced isolation and security review; #565–#568, #573–#575 |
| Maturity / stability | C | Original OOM workload, bounded state and recovery; #569, #570 |
| Community / bus factor | D | Actual independent humans and succession evidence; #576, #577 |
| Docs honesty | A | Exact claims, releases, failures and limits; #564, #578 |
| Production readiness | C− | Installed operation, recovery and shared-owner boundaries; #570, #573–#575 |

The full criteria and all eleven required issue reconciliations are in the JSON
contract. Reconciliations retain dated evidence links and scope limits. Closed
tickets, merged source, unintegrated proposals and reported release observations
remain distinct. They cannot establish that a newly selected distribution passes.

| Profile | Candidate qualification matrix | Required boundary |
| --- | --- | --- |
| Local single owner | Windows installer/npm/source; Linux npm/source/container; macOS npm/source | Trusted owner and loopback default; local MCP retains configured host privileges; remote tools/providers receive selected data |
| Authenticated persistent worker | Linux pinned container/service; Windows pinned native service | Separate worker authority, private snapshots, enforced capabilities, resource/health/backup/recovery controls and proven worker-local schedule provenance |
| Shared/public | Linux hardened pinned container/service with authenticated ingress | Principal/owner binding, isolated storage/processes/credentials, sharing/revocation/conflict checks and independent security acceptance |

These are matrices to qualify, not declarations of a supported current release.
The current source runtime range is explicit and checked against `package.json`.
Provider credentials/subscriptions/quotas or a compatible local model, plus each
tool's git/Python/uv/browser prerequisites, remain part of qualification.
Authentication alone does not prove multi-owner isolation. The explicitly deferred
#212/PR #1233 remains preserved and does not become a local-only exclusion.

## Numeric preregistration

All thirty budget definitions retain their units, denominators, observation
windows and protected minima. Examples include ten weekly independent users for
eight elapsed weeks; eight successful novices out of ten within fifteen minutes;
two additional human maintainers; three non-author humans across ninety elapsed
days; twenty recovery trials per profile; ten backup round trips; and separate
one-hour, seven-day and twenty-eight-day real-provider stages.

The controlled Persona limits remain unchanged, including strict append/recall
p95 below 150 ms. Simulated days do not become elapsed days. Runtime, recovery,
unauthorized-access and duplicate-effect contracts retain their original scopes.
Enrollment, dropouts, missing outcomes, refusals, failures, downtime, interventions,
manual/skipped gates and uncertain effects stay visible in their denominators.

Version 2 adopts these definitions for **future** measurements under automated
development responsibility. It retains their original declaration/status fields
and does not retroactively reclassify historical results. The previously unset
live-spend cap is now **zero USD**, because this foundation task grants no provider
spending. It is a refusal ceiling, not a claim of funding or enforced accounting.
Unknown charges are not zero. Any positive cap needs an explicit versioned
contract change and task authorization before measurement. No deployment or
repository-admin change is authorized by this contract.

## Check the contract and collect evidence

No dependency installation, network access or provider call is needed:

```sh
node scripts/check-scorecard-foundation.mjs
node --test scripts/check-scorecard-foundation.test.mjs
```

The dedicated scorecard source driver includes the foundation suite and retains
direct exits, raw output hashes, test counts and clean source correspondence.
Run it on a committed clean checkout with a fresh output directory outside it:

```sh
node scripts/check-scorecard-ci.mjs /outside/checkout/new-source-checks
```

Start a real external source/release/evidence collection with:

```sh
node scripts/check-scorecard-foundation.mjs --init /outside/checkout/new-collection
node scripts/check-scorecard-foundation.mjs --collection /outside/checkout/new-collection/ledger.json
```

The parent directory must already exist. Initialization refuses an existing
target, an output inside the checkout, or dirty source. It freezes the committed
contract bytes and records exact source/tree, package version, OS/architecture
and Node version. npm, container and installer identities start separately as
unselected; measurements and grades start empty. Collection records retain
source/artifact/profile/owner, command/platform, actual window/clock, result,
budget bindings, numerator/denominator, raw location/SHA-256 and scope limits.
Raw paths are confined to the external collection and bounded to 5 MiB per file.

A collection check verifies correspondence and structure, including passed
observations' artifact/profile/kind/clock and preregistered observation floors.
Historical collections use their committed package requirements, even after the
current checkout changes Node versions. Simulated measurements record
`simulatedDays` when a budget requires a simulated-day minimum. The checker does not judge
measurement quality, authenticate a human participant, enforce runtime/spend
limits, verify an installed artifact, or accept a release claim. Metadata can be
observed without becoming verified installed content. Failed, skipped, manual
and unknown results remain valid records; they never become passes by omission.

The original [release ledger schema](../../scripts/scorecard.schema.json) and
[final acceptance validator](../../scripts/validate-scorecard.mjs) are unchanged.
Their fixed historical default remains a regression baseline; use an actual
release ledger and the relevant topic validators for release assessment. The new
collection format does not replace that stricter acceptance format. Incomplete
release/grade gates still fail closure, regardless of successful foundation
development. Independent reassessment remains the separate outcome in #578.
