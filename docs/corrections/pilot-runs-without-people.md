# A check that used to need a person (a pilot, a click-through, a "please try it") is a scripted run that CI requires

Issue #577 stayed open for weeks because its pilot waited for people to be invited and to report
back. The same tasks now run as scripted first-time users on every broad qualification.

Enforced by:
- `assertScriptedPilotJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
- `scripts/scripted-pilot/run.test.mjs`

Verified by:
- `npm run pilot:scripted`
