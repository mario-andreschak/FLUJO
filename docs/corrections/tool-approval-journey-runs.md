# Tool approvals are checked in a browser by a script on every broad check, never left as steps for a person

#1284 ended with eleven steps for "the end-of-day browser run" that nobody ran. `scripts/tool-approval-journey/run.mjs` does them on a fresh production build with local stand-ins for the models, in the `First-use journey` job of `verify-full.yml`, and keeps its screenshots and report.

Enforced by:
- `assertFirstUseJourneyJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
- `scripts/tool-approval-journey/run.test.mjs`

Verified by:
- `npm run journey:tool-approval` on a throwaway FLUJO (`scripts/tool-approval-journey/run.mjs`)
