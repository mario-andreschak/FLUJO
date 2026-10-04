# Observed repository controls (#565)

On October 3, 2026 (America/Bogota), GitHub denied an ordinary contributor's
merge, direct push and force push to a disposable branch protected with the
same rule parameters as main. This is enforcement evidence for that fixture.
The attempted positive control failed its ordinary tests and final gate, so an
allowed compliant merge and stale-approval behavior remain unproved.

The [portable control receipt](evidence/engineering-repository-controls-20261003.json)
contains exact revisions, actors, run/job identifiers, rejection messages,
policy parameters and hashes of the retained raw records. Timestamps in that
receipt are UTC. No scorecard grade is awarded by these observations.

## Policy observed

The owner UI was read again at `2026-10-04T01:26:49.572Z`; no settings were
changed during that observation. Main ruleset
[24434701](https://github.com/mario-andreschak/FLUJO/settings/rules/24434701)
and disposable ruleset
[24435558](https://github.com/mario-andreschak/FLUJO/settings/rules/24435558)
were active and each displayed an empty bypass list. The main target is only
`refs/heads/main`; the fixture target is only
`refs/heads/codex/gate-probe-base-20261004`.

Both policies have deletion and force-push protection, one required approval,
Code Owner review, stale-approval dismissal, last-push approval, resolved review
threads and 13 up-to-date required checks bound to GitHub Actions app `15368`.
CodeQL findings protection requires results and blocks errors and high-or-higher
security findings. The two API-visible `rules` arrays matched exactly.

The contributor API omits `bypass_actors`. An omitted field is not an empty
list: the read-only repository auditor correctly rejects that incomplete
response. The owner UI supplies the separate bypass observation; this record
does not claim a successful administrator-API auditor run.

## Actual denial results

The ordinary contributor was `flujo-app`, with push access and without admin
or maintain access. The protected fixture base was
`41921e125fe2750309aa39ff05edede4ff6dcaea`.

| Operation | Observed result | Evidence boundary |
| --- | --- | --- |
| Merge [PR #631](https://github.com/mario-andreschak/FLUJO/pull/631), head `d0612e2df1a8e9cb7fb377631b18fd06d3a884d5` | CLI exit 1; actual GitHub merge API HTTP 405; PR remained OPEN and base was unchanged | The API reported missing Code Owner review and unsuccessful required checks. Other blockers prevent attributing denial solely to the deliberate failed check. |
| Direct fast-forward push of that head | GitHub `GH013`, exit 1; base unchanged | GitHub reported missing review and unsuccessful checks. This exercised the contributor's actual push credential. |
| Non-fast-forward push of `9d0afcb05aef57e3f790d1e78c4354b84bade4c8`, with an exact lease on the fixture base | GitHub `GH013`, exit 1; base unchanged | GitHub explicitly reported that force pushes were prohibited. The operation targeted only the disposable base. |

[Run 37164120406](https://github.com/mario-andreschak/FLUJO/actions/runs/37164120406)
completed with failure. The workflow-contract job had 28 passing assertions and
one deliberately failing assertion (`expected red gate`). Final `verification`
job `111327178664` also failed. The ordinary test baseline failed separately;
Ubuntu release safety included the intentional failure and Windows release
safety was cancelled by matrix fail-fast. Those results are retained, not
counted as passing prerequisites. No administrator merge, auto-merge or bypass
was used.

## Positive control remains incomplete

[PR #639](https://github.com/mario-andreschak/FLUJO/pull/639), head
`edf6531786a11af55023dddce845bccaf6ec67ee`, adds one informational marker to
the same fixture base. Its
[run 37165111072](https://github.com/mario-andreschak/FLUJO/actions/runs/37165111072)
completed with failure: 11 required jobs succeeded, `test` and `verification`
failed. The separately labelled diagnostic memory job was skipped and is not a
required check.

The ordinary report recorded six failed suites, five skipped suites and 858
passed suites; four failed assertions, 11 skipped assertions and 7,945 passed
assertions. Failures concerned adapter expectations, Persona recovery, route
coverage and two missing `micromatch` imports in meta tests. This is an older
precursor revision, not evidence about a newer integration or release. Successful
CodeQL execution jobs do not establish that its findings protection passed.

No compliant merge or stale-approval exercise is claimed. A qualified positive
control still needs fresh passing checks, the required review and an actual
allowed merge under the same policy. Source review performed by agents and an
owner-account approval performed on the user's behalf must be identified as
such; they do not supply independent human scorecard acceptance.

## Remaining Engineering acceptance

The final candidate still requires all 13 checks and both configured scanner
categories at its exact revision, a compliant protected merge, the positive and
stale-review controls, and actual npm/image/installer distribution evidence
bound to the merged main SHA. Release identity/provenance, installed-consumer
checks, the security/release response tabletop and independent A- reassessment
remain separate requirements. This record neither dismisses findings nor
changes scanner policy.
