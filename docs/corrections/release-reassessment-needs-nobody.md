# Every release is reassessed against #578 and the nine scorecard rows by a workflow, never by waiting for a person

The reassessment was once a checklist for the owner: start four workflows by
hand, collect the page, find an outside reviewer, post the report (#578). It
never ran. Now `.github/workflows/release-evidence.yml` starts the full checks
and the 28-day Persona soak on each release, collects the evidence and writes
the reassessment. A check that needs people reads where their results are
recorded (pilot sheets, GitHub, `SECURITY.md`) and stays "Not met" until they
exist; it never asks someone to run it.

Enforced by:
- `scripts/release-reassessment.test.mjs` checks that the workflow runs after every npm release and judges each committed reassessment again from its saved inputs
- `judge` in `scripts/release-reassessment.mjs`
- `waitForChecks` in `scripts/wait-for-release-checks.mjs`
