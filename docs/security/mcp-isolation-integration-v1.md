# MCP container integration v1: source contract and evidence

This integration carries #615's container transport behavior onto current #813
source `3e909494755c9c2dee198debfd1abce62ed23edd`. It preserves the current owner,
tool pagination, transport admission and process shutdown behavior, using the
locked classic SDK 1.31.0 and beta client 2.2.0. No dependency or lock changes
are required.

The original #615 proposal composed these historical foundations:

| Foundation | Exact source head |
| --- | --- |
| Production #580 | `7e79d93ccadaf44ad1cb28376941e22357b4906a` |
| Features #585 | `dfea3ae3a0491f0eb592ddef26e5eed500093ade` |
| Owner auth #582 | `2c02fd0d3e4c36e702537a2e67bdd3d240101533` |
| Isolation primitive #593 | `c405de1643817231294c52f33ed270eb9ba713bf` |
| Principal/BFF origin #596 | `5e99e744b20ade3496d99a127924ae1cefd962ce` |
| Next environment compatibility #612 | `240c56c45a0fb28704d8ce90d6e86d352a7de63a` |

It advances #568; #566/#567/#568 and the A- acceptance gate remain open.
The earlier primitive document describes the OS controls and trusted boundary.
This slice adds application wiring and additional protections described below.

## Opt-in policy and separate approval

The MCP config's optional `isolation` contains the strict policy accepted by
`isolatedMcpPolicySchema`. Its command must equal the configured command/args.
It never carries effective approval. A profile on any non-stdio transport is
rejected, and malformed/null profiles cannot fall through to a host launch.

An operator separately configures absolute `FLUJO_MCP_ISOLATION_FILE` and
`FLUJO_OWNER_AUTH_FILE`. Both are bounded 64 KiB regular JSON files, with private
POSIX permissions required. Windows ACL ownership/privacy is an operator
responsibility and has not been qualified by this code. The owner identities must
match. The approval file has this strict format (synthetic example):

```json
{
  "schemaVersion": 1,
  "ownerId": "example-owner",
  "approvals": [{
    "workspace": "default-workspace",
    "serverName": "example-server",
    "policyDigest": "<64 lowercase hexadecimal digits>",
    "expiresAt": 1791072000000
  }]
}
```

Generate the digest with `isolatedMcpPolicyDigest(policy)` after reviewing the
immutable image, trusted Docker executable/daemon, command, read-only grants,
environment names and limits. This source layer adds no approval/enrollment API or
UI. File access is trusted operator authority; the digest does not authenticate a
caller. Changing a policy requires a new matching private approval. Missing,
invalid, expired, wrong-owner, wrong-workspace, or absent approval denies launch.

A private approval also prevents a config import/edit from omitting its profile
and silently launching that server on the host. If the approval file is explicitly
configured but unreadable, host stdio launch does not silently bypass it. Legacy
configs remain host launches when no isolation file/profile is configured; this is
an opt-in migration slice, not default isolation for every untrusted MCP server.

## Runtime and lifecycle behavior

Both ordinary and beta stdio factories use the approved container launch before
the legacy command/env/runtime-home/shipped-package preparation path. SDK inherited
account environment defaults are cleared for the attach CLI. Only named policy
environment grants reach container creation; FLUJO worker/broker credentials are
not injected. Image pulls, builds, package preparation and host fallback are absent
from this path. Installation/build commands elsewhere in the application are not
isolated by this change and remain an acceptance gap.

V1 rejects MCP Apps, Skills, sampling and elicitation opt-ins; it advertises no
stdio OAuth/URL elicitation capability and returns no host roots. These host
brokers need separate permission design. Beta clients use the SDK's documented
legacy negotiation mode so its disposable sibling cannot clone the attach command
for the same container. Classic MCP servers work through either SDK; modern-only
servers requiring discovery are not qualified for this v1 profile. Ordinary
nonisolated beta auto-negotiation remains unchanged.

The create-then-attach boundary binds a full container ID and random generation.
The integrated launch additionally derives a stable ownership key from the
workspace data root and server name. Docker's atomic name uniqueness prevents a
second process/restarted instance from allocating a new generation over the same
predecessor. Cleanup removes only the current full ID with its matching generation;
creation-error reconciliation never removes a different generation found at the
stable name. In-process active generations cannot be removed by a concurrent test
probe. Unknown cleanup is retained and blocks replacement; a successful retry can
reconcile it. Restarted instances with a predecessor fail closed. Automatic startup
orphan recovery, durable reconciliation/operator UX and multi-daemon coordination
remain pending; stable names do not claim these were implemented.

SDK close and natural transport closure reconcile the managed container, with SDK
callback composition preserved. Reconnect identity includes the policy. Healthy
connection reuse, transport start and final tool dispatch re-read approval. Removing
or changing the config/grant at dispatch stops the bound container and denies the
call. Mid-call revocation is not autonomously polled; stream/task lifetime admission
remains pending. No failed/uncertain business tool call is automatically retried.

The Production receipt retains its runtime ID, workspace, numeric generation,
timestamp and classifications. A whitelisted optional `isolation` observation adds
the container generation and `removed`/`absent`/`unknown` cleanup. Attach CLI exit
cannot qualify unknown container cleanup. Unknown cleanup prevents replacement.
The nested receipt contains no command, token, environment, daemon or mount path.

The integration disables Docker's log driver, ignores server stderr, sets a fixed
256 KiB SDK message buffer, and suppresses isolated argument/progress value logs.
Isolated tool maps bypass the shared global-variable/secret interpolation store;
`${global:...}` references are rejected, with a bounded 4096-item/32-depth argument
scan. SDK errors return a fixed isolated-tool failure instead of payload-bearing
diagnostics. Literal caller-provided arguments still reach the approved server.
These controls do not certify all application log/export surfaces, aggregate host
RSS/CPU across every MCP server, or absence of secrets from allowed tool results.

## Current integration checks

On Windows with Node 22.23.3 and locked Next 16.3.8, the full application
TypeScript check passes. All 280 assertions in 22 complete backend suites and
44 assertions in four complete frontend suites pass without pending tests.
Changed TypeScript ESLint passes with zero warnings; the import boundary check
covers 950 source files with no crossings or stale exceptions.

The locked beta SDK inherits additional Windows environment names beyond the
classic SDK list. The attach environment clears the union of both documented
SDK lists. The expanded factory regression failed before that correction and
passes with it; no SDK account defaults are allowed through the shared helper.

The current config loader can return an error response as well as an array;
dispatch now explicitly rejects that response with a fixed isolation error.
Additional tests exercise actual tool dispatch, denied host-secret interpolation,
grant revocation, and redaction of SDK/config diagnostics. The existing no-client
error path and transport admission checks are preserved.

The two explicit real SDK/container probe cases remain intact but were not run
on this source. The trusted local Docker executable exists; an explicit Linux
named-pipe read-only info request was unresponsive, and a bounded 15-second
request ended with `ETIMEDOUT`. No image was pulled and no daemon was restarted.
Historical container results below are not current live-container evidence.

## Historical #615 source checks

The original checks below belong to #615 and are not qualification of the current
integration. Checkout-local Node 22.13.1, Next 16.3.5, TypeScript 6.0.3 and pinned SDKs were used
on Windows x64. No package/lock/shared-runner files changed. Root owns dependency
remediation and the heavy-check slot. Full repository typecheck/build/CI at this
integration revision remain pending; prior foundation typechecks are not borrowed.

The focused commands use the ignored Windows discovery override documented in
#582/#593. A nine-suite intermediate run passed 175 tests covering new transport
guards, primitive controls, both SDK factory paths, pagination, lifecycle receipts,
runtime-home compatibility, and owner/principal/proxy admission. After the final
stable-name/reuse additions, the affected suites and source probes were rerun.
The final affected four-suite run passed 79 tests and both real SDK/container
source probes passed. After composing #612's deliberate production `NODE_ENV`
fix, affected checks were rerun; that controlled CLI value is not inherited from
the host, and a declared `NODE_ENV` grant must be production.
The composed final run passed 60 primitive/transport tests plus both real SDK
container probes. The primitive/test scoped TypeScript check including Next's
ambient types, all changed-file ESLint checks, and staged/unstaged diff checks
passed. Full semantic checks of the newly wired application graph remain pending.

```powershell
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/mcp/isolatedMcpTransport.test.ts __tests__/security/isolatedMcp.test.ts __tests__/mcp/mcpConnectionLifecycle.test.ts __tests__/mcp/lifecycleShutdownReceipts.test.ts
$env:FLUJO_RUN_ISOLATION_SOURCE_PROBE='1'
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/mcp/isolatedMcpContainerSource.test.ts
```

The explicit source probe uses only the already installed local immutable image
`sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad`
on `npipe:////./pipe/dockerDesktopLinuxEngine` via the trusted absolute Docker CLI.
It creates two tiny serial synthetic containers (128 MiB, 0.5 CPU, 32 processes),
never pulls an image or calls a provider, and cleans only its own resources.
Registry provenance and executable content attestation were not verified; an
approved path is not a binary digest.

Both real SDKs performed a classic handshake, discovered two tool pages, retained
title/output-schema/task declarations, executed a tool with observed non-root,
denied root write, absent unrelated env, explicit granted env, memory cgroup bound
and absent host OAuth capability. A nested global-secret reference was denied;
the server's call counter proved it was not dispatched. Revoking the private grant
then denied the next call and removed the exact container. Both cleanup observations
were `removed`. The shared storage/config services are synthetic stubs, so this is
a source/SDK/container journey, not an installed Next server or browser journey.

Failures retained: three early source probe runs failed both tool-call cases after
successful handshake/discovery because a storage stub returned undefined instead
of its fallback value. The first PowerShell wrapper reported native exit 0 despite
the failed Jest summary; later wrappers propagated the native exit correctly.
The stub was repaired, both cases passed, and subsequent isolation/logging/secret-
reference/ownership changes were re-probed. Those failed runs remain failures.

Packed npm/image/installer negatives, root's exact remediated dependency candidate,
public/remote client journeys, browser pairing, approval/migration UX, install-time
and live revocation behavior, human acceptance, and independent reassessment remain
open. No release or deployment is certified by these source tests.
