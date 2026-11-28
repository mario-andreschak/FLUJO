# Security policy

FLUJO is currently a trusted-owner local agent runtime. Use current supported
release artifacts, bind to loopback, review MCP code before installation, and
use a private encryption passphrase. The public default encryption password
is compatibility protection and does not keep credentials private from someone
who obtains the data files. Existing legacy records are not automatically
re-encrypted. Workspace boundaries do not provide multi-user authorization.

Local MCP servers and installation scripts can execute with the host user's
filesystem, environment and network privileges. A trust checkbox, scanner score
or MCP App iframe does not sandbox those processes.

Three protections are available but **off unless the owner turns them on**
(delivered in #566, #567 and #568):

- Owner login, browser sessions and scoped API access
  ([owner access](docs/security/owner-access-v1.md),
  [first-owner pairing](docs/security/first-owner-pairing-v1.md)). Network and
  Public modes refuse to start without it; a local install has no login.
- A private encryption passphrase, with checked migration of older records
  ([private encryption profiles](docs/security/private-encryption-profiles-v1.md)).
- Container-isolated MCP servers and owner consent before host launches
  ([MCP execution profiles](docs/security/mcp-execution-profiles.md)).

FLUJO is not a multi-user system. Do not expose it publicly without owner login.

## Supported versions

Only the latest published release receives security fixes. FLUJO publishes
patch releases often, so update to the newest version of the npm package,
Docker image or Windows installer. Every release is signed and carries a
dependency list (SBOM); see
[release distribution verification](docs/release-distribution-verification.md).

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** private reporting channel
for [this repository](https://github.com/mario-andreschak/FLUJO/security).
Private reporting was confirmed on again on November 25, 2026, and
`npm run check:security-response` fails if it is ever turned off. If the private
channel is unavailable, ask the maintainer for confidential contact without
posting exploit details or secrets in a public issue.

What happens next, and how fast, is written in
[vulnerability response](docs/security/vulnerability-response.md). The targets:

| Severity | First look | Fix released |
| --- | --- | --- |
| Critical | 2 days | 7 days |
| High | 7 days | 30 days |
| Medium | 30 days | 90 days |
| Low | 90 days | 180 days |

These are targets, not a contract: no named human responder or trained backup
exists yet, and no practice run of the full path has happened.

Security responders: none named yet

The release reassessment reads the line above after every release: it counts the
GitHub handles on it (for example `@name`) and asks for a responder and a backup.

In a private report include affected source commit and installed artifact/version,
OS/install/exposure mode, prerequisites, a minimal sanitized reproduction,
expected/observed behavior, impact, and any proposed fix. Use disposable fixtures.
Never include real tokens, passphrases, session cookies, workspace databases,
private snapshots, provider account/billing data or unrestricted logs.

Keep exploitable details private while the maintainer investigates. Fix review,
advisory publication, affected-version guidance and release verification must
identify their actual evidence. A passing scanner or source test is not a
promise that a released artifact is unaffected. Historical audit findings and
unresolved high-severity issues remain visible until remediation is verified.

## Independent security review

None yet. An outside threat-model review of an installed release, with zero open
high or critical findings, is still missing ([#578](https://github.com/mario-andreschak/FLUJO/issues/578)).
When one is published, add it here as a list item, `- [Reviewer, date](link to the
report)`; the release reassessment looks for such an item after every release.
