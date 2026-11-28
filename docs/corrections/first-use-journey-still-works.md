# A new user can still connect an AI, test a tool, build and run an agent and reuse it

`scripts/first-journey/run.test.mjs` keeps the journey's steps covering this whole path, but only the journey itself shows that the path works. It runs on a fresh production build in the `First-use journey` job of `verify-full.yml`, on desktop and phone screens, and fails on a page crash or a path slower than 15 minutes.

Enforced by:
- `assertFirstUseJourneyJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`

Verified by:
- `npm run journey:first-use` on a throwaway FLUJO (`scripts/first-journey/run.mjs`)
