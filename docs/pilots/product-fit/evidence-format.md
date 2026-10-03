# Offline evidence format (`pilot-v1`)

The authoritative validator is [evidence.mjs](../../../scripts/product-fit-pilot/evidence.mjs). Every object accepts **exactly** the fields listed here; no extra fields, free text or URLs are allowed. All listed fields are required even when nullable. The collector is manual and offline; this schema is not an app telemetry/identity API.

Create the empty root with `cli.mjs init`. Keep populated input, raw receipts, contact mappings and private reports outside Git and outside FLUJO's runtime data. SHA-256 references do not redact a file, establish identity, sign consent or verify a task by themselves. The independent reviewer needs access to the genuine retained evidence within the consented scope.

## Root and agreement

| Field | Type / allowed values |
| --- | --- |
| `schemaVersion` | `1` |
| `protocolVersion` | `pilot-v1` |
| `evidenceMode` | `human-observations` or `synthetic-fixture`; fixture mode can never produce human acceptance |
| `rubric` | Object described below |
| `startedAt` | UTC ISO timestamp or null before enrollment |
| `artifacts` | At most 100 artifact records |
| `workflows` | At most 20 task-protocol records |
| `participants` | At most 100 participant records |
| `journeys` | At most 100 first-attempt records; one per participant |
| `controls` | At most 1,000 approval/debugger/proxy-extension attempts |
| `weeks` | At most 5,200 participant-week records; one per participant/week |
| `feedback` | At most 1,000 feedback records |

`rubric` has `status` (`proposed` or `agreed`), `agreementSha256` (64 lowercase hexadecimal characters, nullable only while proposed), `agreedAt` (actual UTC agreement timestamp when agreed, otherwise null) and `targets`. Real enrollment requires an agreed rubric and a declared start. Agreement must occur on or before every enrollment and the declared observation window, not be added after measurement. Use a private receipt for the maintainer/reviewer agreement; do not mark an agreement from a hash of an unsigned draft. The private report retains both the timestamp and receipt digest; neither is disclosed in the public export.

`targets` has `users` (1–100, proposed 10), `weeks` (2–52, proposed 8), `workflows` (1–20, proposed 3), `novices` (1–100, proposed 10), `noviceSuccessRate` (greater than 0 and at most 1, proposed 0.8) and `firstRunSeconds` (1–86,400, proposed 900). Preserve every earlier report if targets change; a changed contract needs new agreement and cannot silently reclassify a failed pilot.

All timestamps use actual UTC dates in the form `2026-10-03T21:00:00.000Z`; invalid calendar dates and dates after the report cutoff fail. The cutoff itself cannot be in the future. Assign IDs independently of names/contact details: `p001`–`p999`, `a001`–`a999`, `w001`–`w999`, `f001`–`f999`. Full commits are 40 lowercase hex characters and SHA-256 values are 64. Do not encode a name, key, private URL or workspace ID in these fields.

## Artifact and workflow records

An artifact has `id`, `kind` (`source`, `npm`, `image`, `installer`), `version` (bounded numeric semantic version, optional prerelease), `sourceCommit` and `sha256`. Hash the exact package archive, installer bytes or retained canonical image identity/provenance receipt. For `source`, hash the source acceptance receipt and record its full commit. Do not describe a source build as a published package. Retain the install method, OS, runtime/browser/tool versions, source mapping and provenance checks separately. The tool trusts operator declarations; it does not download or attest an artifact.

A workflow has `id`, `purpose` (`practice-fixture` or `normal-workflow`) and `protocolSha256`. Hash its private, predeclared task definition. Distinct workflow IDs must have distinct protocol hashes. The reviewer still checks that they represent distinct real problems. Weekly active/recurring targets exclude practice workflows. A novice's genuine model-plus-MCP first run may use the safe practice fixture.

## Participant and consent records

A participant has `id`, `role` (`independent-human`, `maintainer`, `automated`, `promotional`), `novice` (boolean), `enrolledAt` and `consent`. No name, email, provider account or private deployment details are accepted.

`consent` has `version` (`pilot-v1`), `collectedAt` (on or before enrollment), `collection` (must be true), `publication` (`private-only` or `aggregate-only`) and `withdrawnAt` (timestamp or null). Consent covers the actual protocol, retention policy and reviewer access; an operator selecting true is not proof of consent.

For withdrawal, delete that participant's journey/control/week/feedback observations; the validator rejects any remaining ones. Follow the [consent packet's handling policy](recruitment-consent.md) for contact mappings/receipts and the unlinkable denominator tombstone. Withdrawn people remain in the original frozen cohort denominator. Late enrollees and non-independent roles are reported as excluded, never replacements for drop-outs. The tool cannot establish real human independence or erase records itself.

## First-attempt journey records

| Field | Type / meaning |
| --- | --- |
| `participantId`, `artifactId` | Known IDs |
| `startedAt`, `endedAt` | First attempt's actual interval, within the consented pilot window |
| `provisioningSeconds` | Integer 0 through total journey seconds; receipt must retain non-overlapping external provisioning intervals/reasons |
| `coaching`, `coding` | Booleans; either true disqualifies the novice success target, but keeps the observation |
| `status` | `completed`, `failed`, `abandoned`, `provisioning-blocked` |
| `mcpToolCompleted`, `modelReplyCompleted` | Booleans describing actual observed results |
| `receiptSha256` | Genuine private receipt digest; required for completion, otherwise nullable |
| `dropOff` | `none`, `install`, `model`, `connect`, `inspect`, `tool-test`, `agent`, `approval`, `debugger`, `proxy` |
| `failureCode` | Finite code below |

Completion requires both the actual MCP result and model reply, a retained receipt and no failure/drop-off code. First attempts require distinct receipt digests across participants. Non-completion requires its stopping boundary and failure code. The elapsed product time is `(endedAt - startedAt) / 1000 - provisioningSeconds`. The report separates provisioning totals, product timings, provisioning blocks, coaching/coding, drop-off/failure codes and missing observations. It does not treat a failed or unobserved novice as removed from the denominator. Store later retries/fix confirmation in feedback/private follow-up receipts, not a replacement first attempt.

## Approval, debugger and connection-reuse records

Each control attempt has `participantId`, `artifactId`, `kind` (`approval`, `debugger`, `proxy-reuse`), `observedAt`, `outcome` (`completed`, `failed`, `not-attempted`), `checks`, `receiptSha256` and `failureCode`. Its timestamp must be within the consented pilot window. A completed attempt needs a genuine receipt, all of its checks true and failure code `none`. A failed attempt needs its failure code; an explicit non-attempt has all checks false, null receipt and code `none`. Preserve failed attempts when a later retry completes.

`checks` contains exactly these boolean fields for its kind:

| Kind | Required observed boundaries |
| --- | --- |
| `approval` | `blockedBeforeDecision`, `approvedAfterReview`, `rejectionPreventedCall` |
| `debugger` | `pausedAtNode`, `inspectedToolResult`, `resumedToCompletion` |
| `proxy-reuse` | `sameConnection`, `discoveryCompleted`, `invocationCompleted` |

The private receipt must support those observations on the identified artifact: approval before execution plus denial without a call; paused-node/tool-result inspection plus resume; or discovery plus real invocation using the same configured connection through the MCP proxy/OpenAI-compatible agent endpoint. A copied URL, form screenshot or green connected badge alone does not prove completion. Record exact client/transport versions and authentication prerequisites in the private operator packet.

Duplicate same-participant/artifact/kind/time attempts fail. Reusing a receipt for the same boundary fails, including across participants; one genuine combined receipt may cover different control kinds. The private summary reports reported/missing participants, unique installed-artifact completions, failed attempts, explicit non-attempts and source-only records separately for each kind. These measurements do not add a self-awarded grade or change the proposed novice/retention targets. Default public output does not include control observations or their small groups.

## Weekly records and attempted tasks

A week has `participantId`, `week` (1 through the target), `reportedAt` and `tasks` (at most 100). Week 1 is `[startedAt, startedAt + 7 days)`. A report must occur after that whole week ends and by the cutoff. No report means missing; `tasks: []` is an explicit report of no attempts. An unfinished calendar week never contributes retention, even if some runs passed early. Late reports may fill a previously missing week but remain visible in immutable earlier reports.

Every task has `workflowId`, `artifactId`, `completedAt` (terminal success/failure time inside that week and after enrollment), `outcome` (`completed` or `failed`), `mcpUsed` (boolean), `receiptSha256` (required for completion, otherwise nullable), `benefit` (`none`, `unmeasured`, `time-saved`, `better-control`, `connection-reuse`), `interventions` (integer 0–100) and `failureCode`. Failed tasks cannot claim practical benefit. A task receipt cannot be counted twice across participant-week records. Keep each failed and subsequent successful attempt, each with its own actual receipt when available.

Weekly active use requires at least one completed MCP task on an installed candidate for a normal workflow. The report's `inactive` field means **no qualifying normal-workflow run in a returned report**; source/practice/failed attempts may still be present. Source and practice attempt totals are reported separately. Retention is the intersection of users qualifying in every completed week, and its gate remains pending until all target weeks have actually elapsed. A recurring workflow additionally needs the same participant's qualifying run with practical benefit in two distinct completed weeks. Mere engagement, synthetic fixture repetition or an `unmeasured` benefit cannot fill that target.

## Feedback and confirmation records

Feedback has `id`, `participantId`, `reportedAt`, `category` (`onboarding`, `runtime`, `tools`, `approval`, `debugger`, `proxy`, `accessibility`), `severity` (`minor` or `severe`), `failureCode`, `issueNumber` (positive integer or null), `fixCommit` (full fixed-candidate source SHA or null), `confirmedArtifactId` (known artifact ID or null), `confirmedAt` (UTC timestamp or null) and `confirmationSha256` (receipt digest or null).

Confirmation requires the redacted tracked issue, fixed candidate revision and all artifact/time/receipt fields. Its time must be at or after the failure report and no later than the report cutoff. The artifact's source pin must equal `fixCommit`. A source-only confirmation does not clear an installed-artifact severe failure. Severe feedback from every recorded participant is considered, including late joins or non-independent roles. Append a new feedback record when the problem recurs; retain the history. The tool does not file an issue, verify commit ancestry or judge whether a failure is severe.

Each failed first attempt, weekly task or control attempt needs feedback with the same participant/failure code, reported at or after that failure, to classify its severity. A single feedback report can classify multiple related earlier failures; the reviewer checks the genuine receipt and severity rationale. A recurrence after the report requires new feedback. The private report counts `unclassifiedFailures` and keeps failure confirmation pending while any remain, even if later runs succeeded. It also remains pending for a cohort with no attempted observations. Missing and non-attempted records are not invented failures or evidence of absence of severe problems.

Failure codes are `none`, `installation`, `prerequisite`, `authentication`, `quota`, `discovery`, `tool-form`, `tool-call`, `model-binding`, `runtime`, `approval`, `debugger`, `proxy`, `accessibility`, `unclear-next-step`, `other`. Successful journeys/tasks require `none`; failed journeys/tasks and feedback require an actual failure code. Keep prose and severity rationale only in consented private receipts. Do not paste raw logs, screenshots, prompts or tool parameters into this JSON.

## Output and evidence limits

The private report binds the input bytes and exact validator/CLI files with SHA-256 and includes artifact pins. It reports arithmetic target gates as `pending-agreement`, `pending-evidence`, `recorded-target-met` or `fixture-only`. “Recorded target met” is not independent acceptance, verified identity, elapsed live operation proof, product usability proof or a letter grade. `externalReassessment` always remains `required`.

The default stdout export contains protocol/mode/cutoff date, elapsed complete weeks, consent status and only permitted aggregates. It suppresses small nonzero cells and complementary cells below five people; corresponding target gates say `suppressed`. Workflow-benefit and severe-feedback gates say `private-review-required`, avoiding disclosure of those potentially small groups. Any private-only participant withholds all observation counts/gates. Raw timings, per-week breakdowns, feedback and artifact identities remain private. Review cumulative releases for differencing disclosure. The operator controls filesystem privacy, retention and any separately authorized publication; no remote collection endpoint exists.
