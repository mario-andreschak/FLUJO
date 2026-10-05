# Independent MCP workflow pilot

This packet supports [#577](https://github.com/mario-andreschak/FLUJO/issues/577) and supplies journey requirements for [#572](https://github.com/mario-andreschak/FLUJO/issues/572). FLUJO's intended value is a local MCP hub whose connections can be inspected, used in visual agents, debugged, approved, and reused by other clients. Measure whether people actually return to those workflows and benefit from that control.

**Status: preparation only.** No participants, consent, candidate installed-artifact acceptance, eight elapsed weeks, or independent scorecard reassessment are supplied by this change. Numeric targets remain proposed until the maintainer and independent reviewer agree them under [#564](https://github.com/mario-andreschak/FLUJO/issues/564). Fixture/test success validates the collection tool, not product fit or real usage.

## Use the packet

| Material | Purpose | Owner or consumer |
| --- | --- | --- |
| [Task protocol](tasks.md) and [practice fixture](fixtures/sample-notes.txt) | Reproduce the first model-plus-MCP run and the approval/debugger/proxy extensions | Pilot operator; Feature surface |
| [Journey requirements](journey-requirements.md) | Concrete UI outcomes and observation boundaries for #572 | Feature surface; accessibility/release acceptance |
| [Recruitment and consent drafts](recruitment-consent.md) | Obtain separate enrollment and publication choices | Accountable human pilot owner; Community coordinates its separate #576 program |
| [Evidence format](evidence-format.md) | Collect pseudonymous structured observations locally | Pilot operator; Docs #564/#578 evidence ledger |
| [Offline reporter](../../../scripts/product-fit-pilot/cli.mjs) | Validate records and calculate honest denominators | Pilot operator; independent assessor |

The pilot is separate from FLUJO's anonymous daily-active pulse. That pulse rotates identifiers daily and cannot prove eight-week individual retention. This tool does not read app data, subscribe to telemetry, contact a server, enroll anyone, or start a model/tool call. Operators manually enter only the consented fields.

## Agree the observation contract before enrollment

Proposed defaults are ten independent users active in each of eight consecutive **elapsed** weeks; three distinct normal MCP-first workflows with the same person's verified use and reported practical benefit in at least two different weeks; and a cohort of at least ten novices with at least 80% completing their first model-plus-MCP agent run in 900 seconds of product time, without coding or live coaching. The 80% denominator includes every enrolled independent novice in the frozen cohort, including missing reports, provisioning failures and withdrawals. A larger cohort does not permit selecting its best ten results.

The cohort freezes at the declared `startedAt`. Late joiners, maintainers, automated accounts and promotional participants are recorded separately and cannot fill the target. A weekly report can explicitly record no attempted tasks. No report means missing observation, never assumed inactivity or success. A successful source checkout is useful source evidence but cannot fill the installed-artifact gates. Practice tasks cannot satisfy recurring-workflow benefit.

Record each user's OS, install method, provider/transport prerequisites and accepted spend/effect limits in a **private operator packet**, separate from contact details and this schema. Obtain permission before provider charges or external effects. Start with a local single-owner installation; shared/public profiles and unattended Persona claims require their own gates. Do not turn the pilot into an unapproved deployment or endurance run.

The rubric agreement receipt must retain the exact targets, timing definition, independence criteria, cohort selection, start time, three workflow definitions, severe-failure definition, publication threshold, retention/deletion policy and accountable human owner. Store its SHA-256 in `rubric.agreementSha256` and its actual UTC agreement time in `rubric.agreedAt`. The validator rejects agreement after enrollment or the observation window starts. The hash and timestamp are references to evidence, not a signature or agreement by themselves.

## Collect and report offline

Use Node.js 22 or newer. No npm install is needed for the reporter. Choose a private, access-controlled folder **outside the repository and FLUJO workspace data**; create it yourself. Example paths below are placeholders, not defaults that the tool creates.

```sh
node scripts/product-fit-pilot/cli.mjs init --out /private/pilot/pilot.json
node scripts/product-fit-pilot/cli.mjs report --input /private/pilot/pilot.json --as-of 2026-10-03T21:00:00.000Z --private-output /private/pilot/report-001.json
```

In PowerShell, supply your own private paths, such as `--out 'D:\PrivatePilot\pilot.json'`. The UTC `--as-of` timestamp is the actual report cutoff and must not be in the future. The example date does not start a pilot. `init` writes a proposed contract with an empty roster and null start; it refuses to overwrite an existing file. Edit the local JSON using the [format reference](evidence-format.md). Human enrollment is rejected until the rubric is marked agreed and its receipt digest is present.

`report` writes a consent-aware aggregate summary to stdout. Redirect that only after reviewing it. With `--private-output`, it also writes a new local report with exact artifact identities, denominators, failure/drop-off counts, provisioning/product timings, interventions, input checksum and tool checksums. It never overwrites previous reports. Validate the public JSON before publishing; the tool does not publish it for you.

Record the approval, debugger and connection-reuse extensions in `controls`, with the actual observed checks and a private receipt. The private report distinguishes installed completions, source-only checks, failed attempts, explicit non-attempts and missing participants for each boundary. Those counts stay out of the default public export. The protocol/schema remains a pre-enrollment draft: regenerate an empty proposal after a source/schema update and retain earlier source receipts with their exact tool checksums. Do not silently rewrite populated observations or an agreed contract.

Public output contains no participant IDs, raw timestamps, artifact pins, prompts, tool arguments, filenames, screenshots, contact details or free text. It withholds cohort/outcome counts when a nonzero group or its complement has fewer than five people. Any `private-only` consent withholds all observation counts and target gates from that export; it does not filter people out to improve the denominator. Review multiple exports together for disclosure through differences. Small-cell suppression reduces disclosure but is not a formal anonymity guarantee.

## Review failures and close the feedback loop

Review weekly failures and interventions alongside active use. A user whose workflow required recovery still completed a task; retain the intervention count. A failing tool or severe runtime problem requires a redacted issue, an exact fixed candidate revision and a confirmation receipt on the identified installed artifact. A source test cannot clear that installed confirmation. `fixCommit` is the full source revision of that fixed candidate, not necessarily the earlier individual fixing commit.

Classify every failed journey/task/control attempt in feedback, using its participant/failure code and a report time at or after the failure. The report keeps failure confirmation pending while any failed observation is unclassified; an older classification cannot hide a later recurrence. An unobserved cohort cannot establish that failures were handled. Severity and confirmation still require independent review of the genuine retained receipts.

Before publishing an issue, a human reviews its minimal reproduction and checks that it contains no private prompts, workspace names, URLs with credentials, logs, keys or unapproved quotation. The collection format stores an issue number and codes, not its text. Keep before/after receipts privately. If a failure recurs, record new feedback rather than deleting the earlier failure. Track any raw evidence that could not be retained as missing; never invent a digest.

The private report says `recorded-target-met` only for arithmetic over operator-entered observations. The assessor must inspect the actual consent, identities/independence attestation, artifact provenance, task receipts and elapsed calendar window. This program never awards A- or closes #563/#577. Installed-release acceptance, authorized recruitment, the real observation window and independent reassessment remain separate work.

## Check the tool

```sh
node --test scripts/product-fit-pilot/evidence.test.mjs
```

Tests include synthetic positive and negative controls for completed weeks, retention intersections, withdrawals, failures, coaching, practice/source exclusions, severe-failure confirmation and privacy. They are not real-user observations. The report accepts up to 4 MiB of local JSON with bounded record counts. Unknown fields, unsupported values, invalid timestamps, duplicate records/receipts and future observations fail without printing submitted values. File permissions request owner-only access on Unix; Windows uses the containing folder's ACL. The tool does not establish that ACL or erase the private inputs for you.
