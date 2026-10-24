# Project status and release channels

This page describes capability maturity and release limits. A package version or a passing source check does not establish acceptance of a published artifact.

| Capability | Status | Evidence and limits |
| --- | --- | --- |
| Model connections, interactive chat, visual agents | Available | Credentials, quotas, model compatibility, and tools remain external dependencies |
| Natural-language flow generation | Available | Generated flows require review and validation before use |
| MCP tools/resources/prompts/Apps | Available | Local servers execute on the host; remote servers receive request data |
| Workspaces and portable workers | Available | Logical isolation is not multi-user auth; snapshots can contain credentials |
| Schedules and triggers | Available | Server must be running; failures and approvals may need owner attention |
| Personas, Roles, persistent goals | Experimental | Short tests and controlled acceptance do not prove indefinite unattended operation |
| Conversation-scoped MCP Skills / experimental generator | Opt-in | Feature/server configuration determines availability |

The development source also contains an opt-in [owner API bearer policy](security/owner-access-v1.md). It preserves anonymous localhost behavior when unset and has no browser login/session lifecycle yet. Installed-client migration, complete handler/stream enforcement and independent security acceptance remain open. The [MCP isolation primitive](security/mcp-isolation-v1-evidence.md) is not yet called by the app's transport; it does not change the host privileges of currently connected servers. These source components do not establish an accepted public/shared release.

## Release identity

The package version identifies a published release only when installed from that release. A source checkout on `main` can be ahead of the latest tag while retaining its package version. Record `git rev-parse HEAD` and `git status --short` when reporting source-build problems. Include install method, operating system, and relevant error; omit credentials and private prompts.

The npm package uses versioned releases. Windows bootstrappers built from the current source pin the release tag and commit; earlier published installers can still follow moving `main`. Shell/source installs use the development branch unless explicitly configured otherwise. Stable detached installs upgrade through a newer versioned installer, while clean development checkouts support fast-forward updates. Read the release notes before upgrading and back up workspace data before changing versions.

## Validation and acceptance

During development, use local typecheck and lint, plus a non-container application
build before committing. Full CI, security scanners, broader regression suites
and installed-artifact acceptance run immediately before a release. Automatic CI
on merge is paused.

Release acceptance must bind results to an exact source revision and distributed
artifact. It must cover the declared operating systems and installation methods,
security boundaries, recovery and rollback, human operation and any required
elapsed live-provider checks. Source fixtures and short simulations do not
establish unattended reliability or shared/public deployment support.

Keep run records and operator ledgers outside the public repository. Historical
regression checks read their fixed inputs from Git history; the default
`scripts/validate-scorecard.mjs` command checks that historical baseline and
cannot qualify a current release. Its schema and all acceptance assertions remain
maintained under `scripts/`. Pass a current external ledger when assessing a new
candidate.

Open issues are tracked in [GitHub](https://github.com/mario-andreschak/FLUJO/issues).
Release notes belong in [CHANGELOG.md](../CHANGELOG.md), including migration
requirements, known regressions and experimental limits.
