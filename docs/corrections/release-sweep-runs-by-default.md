# The release sweep runs and files after every release with no switch, needs only the built-in token and has time limits

It was first built switched off behind a `RELEASE_SWEEP` repository variable, which left a person in the
loop and added one more setting (#1449). Filing is safe on its own: fingerprints, dedup against open and
recently closed issues, at most 5 new problem issues per run, and the sweep machine's own failures are
never filed (`docs/release-sweep.md`).

Enforced by:
- `assertReleaseSweepRunsByDefault` in `scripts/workflow-contract.mjs`, run on the real workflows by `scripts/workflow-contract.test.mjs`
- `scripts/release-sweep/issues.test.mjs`
- `scripts/release-sweep/run.test.mjs`
