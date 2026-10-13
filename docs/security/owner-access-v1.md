# Owner access and security compatibility contract v1

Status: proposed implementation contract for #566–#568, October 3, 2026.
Independent threat-model review, #564 agreement, installed-artifact acceptance,
and consumer migration approval remain pending. This document awards no grade.
Baseline: `3511ba49514fe8cf525f5a22c16c3806bf3886ba` (source 3.46.2).

## Threat model

Assets are owner configuration, conversations, model/OAuth/environment secrets,
tool and approval authority, filesystem/process access, and worker snapshots.
Attackers include unauthenticated HTTP/MCP clients, a malicious browser origin,
stolen or revoked client credentials, malicious MCP packages/install scripts,
and another principal in a future shared deployment. Compromise of the owner OS
account, a trusted execution adapter, or explicitly trusted host MCP code is
outside the initial owner-ingress boundary. Those processes can already read
owner files; ingress authentication does not sandbox them.

Host/exposure policy, browser origin/CSRF protection, owner identity, encryption
unlock, workspace selection, execution-adapter authority, worker identity, and
MCP capability grants are separate checks. Passing one never implies another.
Workspaces remain logical namespaces, not users or security principals.

## First source slice: opaque API credentials

`FLUJO_OWNER_AUTH_FILE` selects an absolute operator-controlled JSON policy file.
The initial opt-in profile accepts opaque API bearers only. Credentials use
32 random bytes; the policy stores SHA-256 digests, stable grant IDs, an explicit
owner ID, exact scopes, issue/expiry times and revocation time. Random-token
hashing is not password hashing. Tokens are never URL/query parameters or log
fields. The plaintext is returned only by an issuance primitive to its caller.

Proxy and handler independently read the bounded policy on each new request;
no global session state or proxy-supplied identity header establishes trust.
An invalid/unreadable policy returns a generic 503 and does not fall back to
anonymous local access. Expired, revoked or unknown tokens return the same 401;
insufficient scopes return 403. Replacement of a valid policy takes effect on
the next request, including a reconnect, and survives process restart.

| Boundary | Required scopes in this slice |
| --- | --- |
| `/v1/models` | `openai:read` |
| `/v1/chat/completions` | `openai:execute` |
| `/mcp-proxy/**`, `/mcp-flows/**` | `mcp:access`, `control:admin`, `secrets:read` |
| Other `/api/**` and `/v1/**` | `control:admin`, `secrets:read` |

Unknown/new routes default to the conservative control/secret requirement.
There is no wildcard or implied scope. MCP access is deliberately conservative:
FLUJO tools include administrative and secret-bearing operations, so the HTTP
transport cannot grant an execution-only token broad MCP access. Fine-grained
tool dispatch and per-flow grants remain required follow-up work.
An OpenAI execution grant authorizes owner-configured flows and their effects;
it is not an OS/process or model-spend limit. Review those flows before issuance.

The existing exposure and Origin checks still apply. Exact OAuth callbacks
(MCP GET/form POST and registry GET), POST token-authenticated webhooks, and the
six existing snapshot routes with their exact methods retain their own protocol
authentication; snapshot routes keep the separate control bearer. OAuth
initiate/reset require owner authority once the profile is enabled. A callback
exception does not exempt a sibling route. The worker bearer remains independent
and is checked before owner auth. Trusted execution adapters keep their existing
narrow independently authenticated transport and handler contracts. Those
exceptions must never be inferred from a user-supplied identity/header.

The shared workspace route wrapper rechecks credentials before resolving data.
Routes outside it still need individual handler/service coverage; the proxy
alone is not sufficient for completion of #566. Existing anonymous localhost
behavior is retained when no policy is selected. Network/public startup refusal
is a later coordinated launcher change; this first slice does not qualify
unauthenticated or authenticated public hosting.

## Client migration and pending browser lifecycle

- Native OpenAI clients use `Authorization: Bearer <opaque token>` and the exact
  scopes above. Existing model/flow names, query workspace selection, response
  formats and execution IDs are preserved.
- Native MCP clients use the same header with all three MCP scopes. HTTP/SSE
  reconnects must authenticate again. Established streams and transport session
  IDs need continuous revocation/ownership enforcement before #566 acceptance.
- Browser sessions need a separate loopback-only pairing/login implementation,
  fresh server-issued session IDs, HttpOnly/SameSite cookies, exact Origin/CSRF
  enforcement, logout and expiry. The initial bearer slice has no browser login
  UI and must not be enabled on an existing browser-dependent deployment yet.
  Never put an admin token in browser storage or in an EventSource URL.
- Worker restore preserves its dedicated `FLUJO_SNAPSHOT_CONTROL_TOKEN` contract;
  owner policy files and tokens must not be enrolled through copied snapshots.
- FACTORY/O/Brain/Observatory/avatar consumers require explicit migration against
  exact pins through the coordinator. A bearer identifies the installation owner
  only; it does not admit original Root account/budget/OFF/capture authority.
  Preserve original/current IDs, digest recipes, leases, idempotent observation
  and startup/COMMIT/transport fences from the O integration handoff.

Keep the policy outside workspaces, exports and snapshot roots; restrict the
directory/file to the operator (POSIX 0700/0600 or Windows owner-only ACLs).
Hashes are not independently protected encryption keys. Protect backups and
replace policy files atomically. Recovery means returning the listener to
loopback and replacing owner-controlled policy; no remote reset route is added.

## Credential protection and MCP enforcement follow-up contracts

#567 must inventory model/registry/env/MCP-OAuth stores and bootstrap/snapshot
material. New private profiles require an explicit passphrase or an independently
protected operator secret/OS keystore. A key beside its ciphertext and the public
default password are not private protection. Retain legacy reads; migration must
preflight, back up, stage authenticated re-encryption, verify every recoverable
record, and commit atomically with resumable interruption handling. Ordinary
exports must omit credentials; deliberate transfer must use recipient keying and
explicit retention/rollback. Authentication is not encryption unlock.

#568 must bind grants to exact package/source identity and reject unavailable
isolation without a downgrade. Isolated profiles need OS/container enforcement
of mounts, injected environment/credentials, egress, children and resources for
installation scripts as well as runtime. Explicit trusted-host consent remains
separate. Preserve generation ownership and Production's #547 shutdown receipts.
Remote MCP operators have an external-data contract, not a local sandbox claim.
#101/#527 own bounded assistive assessments; scanner scores do not enforce any
filesystem/process/network permission.

## Evidence and review gates

Boundary tests must retain missing/invalid/expired/revoked and scope-denial cases,
cross-origin/forged-forwarding attempts, worker/adapter separation, exact callback
exceptions, policy corruption/oversize, restart/reconnect and handler bypass.
Source tests do not establish installed-package or Windows/Linux isolation
acceptance. Retain exact source and artifact identities separately, then obtain
independent threat review and release/browser/client acceptance. #566–#568 remain
open until their complete matrices pass; shared ownership/sharing is #573–#575.

Guidance: installed Next 16.3.5 proxy/data-security/route-handler/authentication
guides; [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
