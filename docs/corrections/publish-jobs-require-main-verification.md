# A workflow job that can publish or sign first requires the exact-commit `main` verification run

Enforced by:
- `assertReleaseVerificationGates` in `scripts/workflow-contract.mjs` (its exception list only shrinks), run on the real workflows by `scripts/workflow-contract.test.mjs`
