# Maintainer continuity and succession

This is the proposed #576 program. #564 must approve its acceptance criteria.
No additional human maintainer, permission grant or completed observation window
is established by publishing it. Automated changes and test results remain
separate from human evidence. Product adoption belongs to #577.

## Roles and access register

Fill a role only after a named human consents to its scope and a repository owner
approves the required access. Keep private account/recovery details outside Git.
Record a redacted verification reference, verifier and date here or in the epic
evidence ledger; listing a name or CODEOWNERS entry does not prove readiness.

| Duty | Required competence / minimal access | Accountable human | Trained backup / access evidence |
| --- | --- | --- | --- |
| Core change review | Trace execution/ownership and reject a regression; review access first | Not recorded | Missing |
| MCP/security boundary review | Assess process/grant/credential and client compatibility | Not recorded | Missing |
| Release verification | Verify source, candidate integrity, required checks and consumer behavior; no publication permission needed for rehearsal | Not recorded | Missing |
| Release publication / rollback decision | Understand existing exact-SHA release/resume procedure; owner-approved GitHub/npm authority | Not recorded | Missing |
| Private vulnerability triage | Approved private channel, severity assessment and disclosure coordination | Not recorded | Missing |
| Recovery / access rotation | Diagnose, restore synthetic data, verify owned-process shutdown and account recovery | Not recorded | Missing |
| Contributor onboarding / evidence | Maintain starters, review setup friction, obtain consent and retain substantive work | Not recorded | Missing |

One person may hold several duties, but concentration stays visible. Critical
areas require a second trained human with verified access; a bot is never that
backup. Repository enforcement belongs to #565, security policy to #565's Security
owner, and supported operating profiles/recovery to #570/#564.

## Onboarding and promotion

1. Obtain consent for a bounded contributor task and for any retained evidence.
2. Observe the [clean-clone setup](README.md) without the author's hidden files or
   live coaching. Record setup failures and assistance, including unsuccessful attempts.
3. Retain substantive accepted work and a meaningful review explaining boundary
   behavior, compatibility, failure handling and tests. Authorship and review must
   identify independent humans; bot-assisted work must still identify the actual
   human contribution and accountability.
4. Have the candidate review a core change and perform the [drill](maintainer-drill.md)
   without the original author operating it. An observer may record evidence but
   must record any intervention or coaching rather than calling that independent.
5. A consenting accountable owner approves a role and minimal permissions only
   after the evidence is reviewed. Verify access with a harmless authorized read
   or disposable action; record what was verified, expiration/recheck date, and
   private recovery reference. Publication access requires a separate decision.

Promotion is a human decision, not a script output. Do not assign access, contact
prospective humans, or enroll them in this program based on this document.

## Decision and emergency succession runbook

For routine changes, the author proposes one bounded result and a qualified human
reviews it. Record cross-area decisions in an issue with affected consumers and
the accountable owner. A compatibility dispute or missing qualified reviewer
keeps integration pending; escalation cannot manufacture an approval.

If the original maintainer is unavailable:

1. Identify the consenting duty owner and trained backup in the register. If
   either is missing or unreachable, record the gap and keep affected releases
   pending. Availability is not inferred from recent commits.
2. Preserve the exact source/artifact/incident evidence and private backup before
   acting. Identify supported release/profile using the current security and
   project-status policies. Do not adopt an old "latest" claim as release evidence.
3. Use only previously authorized account recovery/access routes. Two humans
   verify the intended scope and retained incident evidence for security/release
   decisions. Keep recovery codes, credentials and account identifiers private.
4. Run the disposable diagnosis/recovery exercise first. Production recovery,
   publication, revocation and controller changes require their actual operating
   authorization and #570's applicable fences.
5. Record who acted, what authority was used, exact revision/artifacts, failures,
   result and next review. An unavailable backup stays an unresolved risk.

For planned access rotation or departure, inventory roles, repository/npm/provider
permissions, trusted publisher settings and private recovery custody; arrange the
approved replacement, verify its minimal access, then have the authorized owner
revoke departed access and rotate affected credentials. Recheck the release
verification path after changes. Record redacted receipts and any missed access;
never commit recovery material or assume all sessions were revoked from one UI.

## Security and release tabletop

Use the current Security owner's private-reporting policy (tracked in #565).
Reporting-channel availability, supported releases, response targets and real
triage ownership must be verified there. Until available, ask the owner for a
private channel without posting exploit details publicly.

With synthetic information, exercise: private report intake, affected supported
versions/profile, severity and escalation decision, reproduction, restricted fix
review, candidate verification, advisory/release decision, and follow-up. Use
[the existing release procedure](../npm-release.md), including exact artifact
integrity and failed-job-only resume after partial publication. A checksum
mismatch or missing exact-SHA check stops the release; do not publish a replacement
version just to hide an unresolved partial failure. The rehearsal performs no
publication or advisory creation. Retain operator/observer, decision times,
redacted steps, missed targets and remaining account-access gaps. An actual private
report and production incident remain separate evidence.

## Evidence record

Proposed targets from #576: **two additional independent human maintainers** able
to review a core change and perform a disposable release/recovery drill; **three
non-author humans** with substantive accepted work/review across **90 elapsed
days**; critical duties with trained, verified backups; a useful first PR from
the published setup without hidden files/private knowledge. #564 must record
agreement before these targets are treated as acceptance.

Current measured count is **not collected**, not zero inferred from repository
history. No observation start/end has been agreed or measured. A simulated window
or a burst of PRs cannot establish elapsed sustained activity. Stars, posts,
automated commits and test counts never substitute for these denominators.

Copy this form per consenting participant/event into the agreed evidence ledger:

```text
Event ID / kind: onboarding | contribution | review | drill | access-verification
Human identity/reference (consented public handle or private evidence ID):
Original author? Independent human? Bot assistance and actual human scope:
Consent date, retention scope and private reference:
Role requested / accountable owner / trained backup:
Observed at (UTC), observer, help/interventions, unsuccessful attempts:
Source SHA / package version / artifact identity + checksum (where relevant):
Accepted PR / substantive review URL and explanation of contribution:
Commands / raw evidence location + checksum / failures / skips:
Drill scope: source rehearsal | installed release | human-operated
Access exercised, owner authorization, redacted receipt, recovery reference:
Outcome, limitations, missing gates, next recheck:
Observation start/end (actual elapsed time), eligible denominator and activity dates:
Rubric agreement URL / independent reviewer decision (pending unless observed):
```

Review records monthly during the agreed window. Keep accepted changes, reviews,
drills and sustained participation as separate measures; count each unique human
once within the relevant denominator. The independent assessor decides the grade.
