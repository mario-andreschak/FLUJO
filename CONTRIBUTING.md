# Contributing to FLUJO

Start with the [contributor setup and first PR guide](docs/contributing/README.md).
It includes disposable data setup, focused checks, and the review policy.

- [Architecture and task map](docs/contributing/task-map.md)
- [Curated starter backlog](docs/contributing/starter-backlog.md)
- [Maintainer roles and succession](docs/contributing/maintainership.md)
- [Disposable release/recovery drill](docs/contributing/maintainer-drill.md)

Never include credentials or personal workspace data in issues, PRs or evidence.
Security policy and private vulnerability reporting are being established in
[#565](https://github.com/mario-andreschak/FLUJO/issues/565); do not report an
unpatched vulnerability in a public issue.

## Keep the checkout small

Save generated audit output, provider traces, test recordings, agent handovers
and media editing projects outside the repository. Only publish media used by
GitHub Pages or a maintained product guide, and reuse identical existing assets.

Historical regression inputs removed from the working tree are read from the
fixed pre-cleanup Git revision by `scripts/read-archived-fixture.mjs`. Those
checks require the repository's history; they never fetch it automatically.
The default scorecard command validates that historical baseline, not the current
release. Pass a current external ledger to validate new release records; its
payloads must exist locally and do not fall back to historical data.
