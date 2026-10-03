# Security policy

FLUJO is currently a trusted-owner local agent runtime. Use current supported
release artifacts, bind to loopback, review MCP code before installation, and
use a private encryption passphrase. The public default encryption password
is compatibility protection and does not keep credentials private from someone
who obtains the data files. Existing legacy records are not automatically
re-encrypted. Workspace boundaries do not provide multi-user authorization.

Local MCP servers and installation scripts can execute with the host user's
filesystem, environment and network privileges. A trust checkbox, scanner score
or MCP App iframe does not sandbox those processes. Authenticated/scoped ingress,
verified credential migration and enforced process isolation are being delivered
under #566–#568; consult the [versioned contract](docs/security/owner-access-v1.md)
for source coverage and remaining acceptance gates. Do not expose FLUJO publicly
on the basis of these unfinished changes.

## Reporting a vulnerability

Prefer GitHub's **Security → Report a vulnerability** private reporting channel
when it is enabled for [this repository](https://github.com/mario-andreschak/FLUJO/security).
On October 3, 2026, the repository API reported that private reporting was
disabled. Enabling it and naming an accountable responder remain maintainer
actions; this file does not claim that a confidential intake channel or response
SLA already exists. Until a private channel is available, open an issue asking
the maintainer for confidential contact, without exploit details or secrets.

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
