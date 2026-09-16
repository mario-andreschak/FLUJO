# Project status and release channels

This page describes capability maturity. The [dated audit](audits/2026-09-16-project-audit.md) records the September 16 baseline; the [remediation record](audits/2026-09-16-remediation.md) tracks subsequent changes and validation. Neither is an automatically updated health badge.

| Capability | Status | Evidence and limits |
| --- | --- | --- |
| Model connections, interactive chat, visual agents | Available | Credentials, quotas, model compatibility, and tools remain external dependencies |
| Natural-language flow generation | Available | Generated flows require review and validation before use |
| MCP tools/resources/prompts/Apps | Available | Local servers execute on the host; remote servers receive request data |
| Workspaces and portable workers | Available | Logical isolation is not multi-user auth; snapshots can contain credentials |
| Schedules and triggers | Available | Server must be running; failures and approvals may need owner attention |
| Personas, Roles, persistent goals | Experimental | Short tests and controlled acceptance do not prove indefinite unattended operation |
| Conversation-scoped MCP Skills / experimental generator | Opt-in | Feature/server configuration determines availability |

## Release identity

The package version identifies a published release only when installed from that release. A source checkout on `main` can be ahead of the latest tag while retaining its package version. Record `git rev-parse HEAD` and `git status --short` when reporting source-build problems. Include install method, operating system, and relevant error; omit credentials and private prompts.

The npm package uses versioned releases. Windows bootstrappers built from the current source pin the release tag and commit; earlier published installers can still follow moving `main`. Shell/source installs use the development branch unless explicitly configured otherwise. Stable detached installs upgrade through a newer versioned installer, while clean development checkouts support fast-forward updates. Read the release notes before upgrading and back up workspace data before changing versions.

## Acceptance evidence

The [CI workflow](https://github.com/mario-andreschak/FLUJO/actions/workflows/verify.yml) checks types, lint, ordinary tests, and isolated process-boundary tests. The current source counts completed assertions and has no active test quarantines. Six opt-in acceptance/performance assertions remain outside the ordinary Windows run; Unix additionally skips five Windows-specific assertions. Read the raw results and the [quarantine retirement record](audits/quarantine-status.md) alongside the overall status, especially when assessing older releases.

Persona readiness has separate [goal acceptance](performance/persona-goal-acceptance.md), [endurance acceptance](performance/persona-goal-endurance-acceptance.md), and [runtime soak](performance/persona-runtime-soak-acceptance.md) criteria. Full endurance claims require a successful run for the assessed implementation revision. A memory benchmark or short smoke test proves only its measured scope.

The September 16 remediation's full offline 28-day simulation completed all 560 activities and passed recovery, retention and learning checks, but failed the event-append latency criterion: one daily p95 was 169.6893 ms against a 150 ms limit. Twelve of thirteen criteria passed; overall acceptance did not. The remediation record preserves the exact snapshot, evidence and unresolved profiling work. This is neither 28 elapsed days nor proof of live-provider unattended operation.

Open issues are tracked in [GitHub](https://github.com/mario-andreschak/FLUJO/issues). Release notes belong in [CHANGELOG.md](../CHANGELOG.md), including migration requirements, known regressions, and experimental limits.
