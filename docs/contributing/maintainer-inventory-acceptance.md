# Complete flow inventory recovery acceptance

This is an execution plan for the source correction after frozen #734, not a
passing result. Execution requires a new coordinator assignment. No tests,
installation, application, rehearsal or release qualification was run while
preparing it. Retain the eventual exact tool revision, supported runtime, command,
platform, raw bytes, receipts, failures and scope with every result.

## Failure and required behavior

The signed public 3.46.2 rehearsal at tool revision
`74156420c64b42a3dc5c1703cd96d533293bb0a0` failed because its backup contained both
`default-agent-flujo` (seven nodes, six edges) and `maintainer_drill_flow` (empty),
while the validator required one flow. Failed receipt SHA-256:
`a349e2af450011f3a2337437f492ecc75c3c8e4c9b3e3f6fbdcc7edac38b4fb5`.
Retained raw ZIP SHA-256:
`54b4be5ad8a7c9ac09805fc7a2d285adff1f1a6aa6937bbb6581ecffc2d569d6`.
Keep those bytes and the failed outcome unchanged.

The intervening #731/#734 projection removed the seeded agent from restore and
comparison. That proves only its narrower fixture scope. This correction instead
retains the whole API ZIP and compares every seeded and created flow. It captures
`initial-flows.json` before creating the fixture and `original-flows.json` after
seeding. The seeded content must be unchanged between these independent API reads.
Any initialization race or unexpected membership is a recorded failure, not a
reason to silently replace the initial observation.

The assigned signed 3.46.2 run at frozen #763 tool revision
`38436d686f3cb6349ab4b5b13be3dea3e45a16d9` failed before fresh-root recovery:
`/api/cwd` succeeded, the initial flow inventory was empty, and the default agent
appeared before the later full inventory. Failed baseline receipt SHA-256:
`30345c971d79ced01ce9adc1ad177fabf6f9c8958a460d536d3aacfbcd631f11`.
Provenance verification and installation passed; recovery did not start. Keep the
original receipt, empty witness and later raw response unchanged.

Before the initial inventory, the corrected probe first verifies installation/data
root identity and then joins the existing memoized backend initialization through
`GET /api/init`. That route awaits storage verification and default-agent seeding.
Each request retains its response and is bounded by the existing 15-second request
timeout; an error, timeout, malformed response or unsuccessful initialization fails
without fixture mutation. A successful response must be followed by an inventory
containing the default agent with a nonempty graph, unique node/edge IDs and edges
referencing existing nodes. These checks establish seed presence and graph
structure; the subsequent independent full-inventory comparison preserves every
other observed field. No arbitrary quiet period establishes readiness. Fresh
recovery, upgrade and restart generations join the same initialization barrier.

The only permitted flow IDs are the observed public seed `default-agent-flujo`
and the prescribed empty `maintainer_drill_flow`. The corrected initial inventory
must contain the public seed; after creation the fixture must exist. Duplicate,
unrelated or Persona-owned flows fail. Collection order and object-key order may
vary. Only top-level server `createdAt`/`updatedAt` are omitted from semantic
comparison. Every other field, graph element, node payload, nested timestamp and
array order must match. Raw timestamp values remain in evidence. The public seed
is stored and restored but never run; no provider or model call is part of this plan.

The separate [conversation acceptance contract](./maintainer-conversation-acceptance.md)
requires complete API and archive observations. The flow timestamp exclusions above
do not apply to conversations. Frozen #763's failure, #774's initialization correction
and their own validation remain separate from this successor's source and outcomes.

## Source and offline controls after assignment

Run the existing maintainer selector at the committed correction on an assigned,
supported runtime, including `scripts/maintainer-synthetic-state.test.mjs`, and
retain actual TAP output. Existing CI selectors already include this file.

```sh
node --test scripts/read-bounded-file.test.mjs scripts/maintainer-drill.test.mjs scripts/maintainer-installed-baseline.test.mjs scripts/maintainer-installed-recovery.test.mjs scripts/maintainer-installed-upgrade.test.mjs scripts/maintainer-npm-provenance.test.mjs scripts/maintainer-synthetic-state.test.mjs
```

The controls must accept a complete seeded-plus-created archive without changing
its bytes and reject missing seed/fixture, duplicate or extra membership, changed
seeded node/edge/favorite/other content, aliased ZIP entries and private state.
Inventory receipts must bind both snapshots' hashes and sizes, exact membership,
the two timestamp exclusions, provenance verification and completed full-archive
comparison. A changed initial seed must fail even with a recomputed file hash.
Historical broader-state receipts without this inventory profile must fail the
new complete-inventory gate while remaining untouched as historical evidence.

Inspecting the retained failed ZIP can confirm its inventory and checksum. It
cannot independently validate the old run's seed inventory: that run did not
capture the new initial/full-flow API snapshots. An expected inventory derived
from the ZIP itself is an offline fixture, not independent runtime acceptance.

## Controlled recovery protocol after assignment

Use disposable HTTP fixture processes with explicitly synthetic seed graphs,
receipt flags and package identities. Label them as protocol fixtures; none
establishes npm signatures, actual installed behavior or a qualified candidate.
Retain the complete request sequence, state files, re-exports and restart evidence.

| Case | Required observation |
| --- | --- |
| Existing-root positive | Every baseline flow and all four selected state kinds match before any restore. Only the two invalid restores are attempted. Full re-export and restart still match. |
| Seed lost or changed on upgrade | Fail before the first restore even while the created fixture remains readable. Restoring the old ZIP must not mask the loss. |
| Fresh-root positive | Created flow/conversation/configuration are absent. Seed inventory matches the candidate's separately recorded initial snapshot. Both rejected restores leave all seed and auxiliary state unchanged. |
| Rejected restore mutates seed | A 400 response with changed seed content must fail, even if the created flow/auxiliary records look unchanged. |
| Valid restore omits or changes seed | A 200 response is insufficient: the full API inventory must match the baseline before re-export. |
| Re-export omits or changes seed | Fail on the unmodified returned ZIP even if API reads look correct. |
| Restart changes seed only | Fail the full post-restart inventory comparison even if the empty created flow and conversation survive. |
| Unexpected initial membership | Reject an extra/private flow, duplicate ID or pre-existing created fixture. |
| Changed snapshot or old partial receipt | Refuse before creating the recovery directory or launching its application. |

After each rejection, retain the failed receipt and inspect cleanup. Owned launcher
exit and closed loopback port remain narrower than graceful, every-generation
shutdown; #547 supplies that separate contract.

## New signed installed rehearsal after assignment

Use a clean committed correction and a newly created consumer/data directory.
Obtain and verify the public package pin independently; the previously used
baseline is version 3.46.2, artifact source
`320347356891aa1c24e0f2f9ce12719317e58bde`. Mandatory npm provenance verification
must complete before install. Follow the existing command in
[the drill guide](maintainer-drill.md#fresh-root-recovery-and-restart), retaining
the resolved lockfile, full API responses, both inventory snapshots, unchanged
backup ZIP, invalid restores, full re-exports and restart receipts.

Require the new baseline and fresh recovery to finish successfully with their
inventory profiles verified. Do not reuse the failed rehearsal's data root or
overwrite its receipt. A failure remains a failure and determines the next fix.
This is same-version acceptance; it establishes no newer-version upgrade.

## Qualified newer candidate and organizational acceptance

Run the two-version command only after the exact newer public candidate satisfies
the existing whole-main CI/SARIF, distribution and signature gates. Preserve any
failed native scan, missing approval or unqualified release as a blocker. Each
consumer must independently capture its initial/full inventory. In-place upgrade
must preserve the baseline's stored flow content before restore; fresh recovery
must reproduce the old backup's full inventory in the new consumer. A changed
seed caused by migration fails this preservation contract; any different migration
contract requires an explicit reviewed specification and its own evidence.

This source correction covers flow inventory and the existing conversation/theme/
non-secret label fixture. Persona, schedules/effects, provider/model configuration,
identity/secrets, generation-aware shutdown, human ownership/access/private triage,
elapsed sustained participation, rubric agreement and independent A- reassessment
remain separate, actual evidence requirements. AI can operate authorized technical
rehearsals; it does not become an independent human maintainer or observer.
