# Every shipped form (npm, Windows installer, Docker) runs the same backup, restart, upgrade, disk-full, schedule and restore checks before release, and the operator runbook is followed word for word

The checks ran only against a stand-in app until they were first run against a
published FLUJO, which showed that two of them could never pass. The broad CI
run now builds and checks the npm package on Linux and Windows, the installed
Windows build and the Docker image from the same revision.

Enforced by:
- `assertPackagedAcceptance` in `scripts/workflow-contract.mjs`, run on the real workflows by `scripts/workflow-contract.test.mjs`
- `scripts/operator-runbook.test.mjs` (every operator step present, in order, for bash and PowerShell)
- `scripts/packaged-acceptance.test.mjs`
