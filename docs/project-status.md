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

The development source contains an opt-in [owner API bearer policy](security/owner-access-v1.md), [browser login/session/logout](security/owner-browser-session-v1.md), and [first-owner pairing](security/first-owner-pairing-v1.md). Pairing requires a configured literal loopback origin and a private local capability. Unconfigured legacy localhost access remains anonymous; Network/Public startup requires an active owner policy. Worker startup retains its separate bearer requirement. Browser sessions and logical workspaces do not provide multi-user ownership or team isolation.

The app's stdio transports call the [MCP container integration](security/mcp-isolation-integration-v1.md) for approved isolated profiles. Protected host launches require separate trusted-host consent; legacy unconfigured localhost installations retain direct host execution. The container path requires a preinstalled immutable image and a trusted local Linux Docker daemon, and fails closed without host fallback. Installation/build commands elsewhere in the app are outside that isolation path. Host servers retain the owner's host privileges. Complete transport/service coverage, installed-client migration, OS/install qualification and independent security acceptance remain separate release requirements; these source integrations do not establish an accepted shared/public release.

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
