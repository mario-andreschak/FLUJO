# A click-through check is a step file or a journey that CI runs, never a list of steps for a person

Issue comments kept ending with "steps for the end-of-day browser check" (#1230, #1231, #1389, #574,
#575) that nobody ran, and the first run found two real bugs. Write the steps as a flujo-drive step file
in `docs/feature-map/steps/`, named by exactly one feature map bullet, and give a missing precondition
a setup in `scripts/feature-steps/setups.mjs`; or write a `journey:*` script. The `First-use journey`
job of `verify-full.yml` runs every step file and the two-person journey on the production build, and
the release sweep runs the step files a fresh FLUJO can run.

Enforced by:
- `checkStepFiles` in `scripts/check-feature-map.mjs`
- `stepFileChecks` in `scripts/feature-steps/run.mjs`
- `scripts/feature-steps/run.test.mjs`
- `assertFirstUseJourneyJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`

Verified by:
- `npm run journey:feature-steps` on throwaway FLUJOs (`scripts/feature-steps/run.mjs`)
- `npm run journey:multi-user` on throwaway FLUJOs (`scripts/multi-user-journey/run.mjs`)
