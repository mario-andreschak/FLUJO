# Every shipped form (npm, Windows installer, Docker) runs the same backup, restart, upgrade and restore checks before release

Enforced by:
- `assertPackagedAcceptance` in `scripts/workflow-contract.mjs`, run on the real workflows by `scripts/workflow-contract.test.mjs`
