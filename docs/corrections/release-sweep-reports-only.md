# The release sweep only reports: it may file issues, never push code, open pull requests or publish

Agents that open a fix pull request for every report mostly add noise, so the sweep starts with
reporting only (`docs/release-sweep.md`). The job that can file issues never installs or runs FLUJO.

Enforced by:
- `assertReleaseSweepReportsOnly` in `scripts/workflow-contract.mjs`, run on the real workflows by `scripts/workflow-contract.test.mjs`
