# Local account controller (development candidate)

FLUJO is local first. Multi-tenancy must work with internet disconnected and LAN
disabled, including cold start, local account enrollment and recovery, private
resources, team permissions, edit locks, history, revocation and restart. No cloud
VM, online identity provider, online DNS or remote isolation lease is required or
permitted as the security boundary. Optional online integrations cannot establish
or maintain that boundary.

This #212/#574 candidate now verifies local passwords and stores authority on the
local machine. The earlier OIDC-only draft is superseded. **Full multi-tenant
support is still incomplete:** actual local runtime isolation, Windows hosting,
team sharing, execution revocation, edit leases and history require further work
and release acceptance. Keep #212 open. No online isolation implementation is
included.

The controller is a separate Node process. It imports no FLUJO execution, MCP,
workspace or encryption modules. Each owner has a distinct browser hostname and
local private runtime, data root, home and service credential. Browser sessions
are opaque host-only cookies. Passwords and administrative bearer credentials are
never supplied to the private runtime through the browser.

## Current development profile

Use Node 22.19+ or 24.2+, a dedicated unprivileged POSIX account, one controller
process and SQLite on a local disk. The candidate currently rejects Windows
because it has no controller-storage DACL implementation; this is an outstanding
platform task, not an exemption from local-first multi-tenancy. Network filesystems
are unsupported. The ordinary FLUJO launcher remains unchanged.

The local OS boundary must protect each owner's files, processes, credentials and
private listener from the other owners' tools. Two unrestricted Node processes
under the same OS account do not establish that boundary. One VM per user is not
required by the product. Do not expose the controller directory, host home,
operator credentials or another owner's storage to a runtime. OS enforcement and
resource limits need qualification before deployment; an `isolationId` only records
an assignment and does not prove isolation.

Runtime upstreams are restricted to literal `127.0.0.1` or `[::1]` on this host;
HTTPS certificate verification cannot be disabled. Runtime tools must also be
prevented from reaching sibling listeners or controller state. Each runtime uses
its existing owner bearer, public exposure mode and exact HTTPS
`FLUJO_OWNER_BROWSER_ORIGIN`; its actual listener remains private.

A local TLS proxy forwards the configured browser Host to `127.0.0.1:4280`.
Configure locally trusted certificates and static local hostname resolution, for
example `alice.localhost` and `bob.localhost` mapped to loopback. Neither resolution
nor certificate provisioning/renewal may require an online service. Do not use a
public DNS resolver, ACME service or certificate bypass to supply the offline
profile. Different ports on one hostname cannot separate owners' cookies and are
rejected. Local TLS/hostname setup is still operator-managed in this candidate.

The proxy must not cache authenticated responses or log cookies, sign-in bodies or
private URLs. The controller ignores forwarded identity; exact browser Origin
checks apply to mutations. No cloud control-plane requests or identity discovery
are made at startup or sign-in.

## Configuration and local enrollment

Create private config and state directories owned by the controller account with
mode 0700. Ancestors must not be group/world writable or symlinks. Config and
optional private-CA files must be mode 0600 with no links. Keep populated configs
and state out of source control. Only the local installation operator may read
the ledger or run enrollment/recovery commands.

```json
{
  "schemaVersion": 2,
  "stateDirectory": "/srv/flujo-controller/state",
  "port": 4280,
  "sessionSeconds": 28800,
  "runtimes": [{
    "id": "alice-runtime",
    "actorId": "alice",
    "origin": "https://alice.localhost",
    "upstream": "http://127.0.0.1:4211",
    "credential": "REPLACE_WITH_ISSUED_OWNER_CREDENTIAL",
    "isolationId": "immutable-local-isolation-identity"
  }]
}
```

`caFile` is optional for a local HTTPS upstream. Credentials use the existing
`flo_v1_` owner-token format and must have the owner's required app scopes. Each
owner, runtime, browser hostname, upstream, credential and isolation identity is
unique. Never reuse an owner's browser hostname for someone else: cookies,
browser storage and service workers can outlive a server session.

```sh
npm run build:controller
flujo-controller init /srv/flujo-controller/config/controller.json
flujo-controller password /srv/flujo-controller/config/controller.json alice
flujo-controller serve /srv/flujo-controller/config/controller.json
flujo-controller status /srv/flujo-controller/config/controller.json
flujo-controller disable /srv/flujo-controller/config/controller.json alice
flujo-controller enable /srv/flujo-controller/config/controller.json alice
```

Use `node bin/flujo-controller.mjs` from a source checkout. `init` requires the
controller to be stopped; it records local accounts but grants no password login
until enrollment. `password` uses a hidden interactive terminal prompt with
confirmation. It requires at least 15 characters, permits spaces and Unicode, and
limits UTF-8 input to 1024 bytes. Never put passwords in command arguments or
configuration. The same local command performs recovery without email or internet
access, revokes existing sessions and invalidates authentication in progress.
Changing a password does not re-enable a disabled account.

Password verifiers use salted scrypt with N=131072, r=8 and p=1, following the
[OWASP password-storage baseline](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The HTTP server permits two concurrent checks, bounds form size and read time,
and reserves exponential per-account backoff durably before checking a password.
Successful authentication resets the backoff. Failed attempts cannot bypass it by
restarting the controller. Operator password recovery resets it locally.

The desktop account control and phone menu open `/_account` for local sign-in and
sign-out. Account access uses the current local ledger on each request, upload
chunk and at one-second intervals during streams. Disabled accounts remain
disabled across restarts; enable does not restore old sessions. Runtime removal,
configuration changes and password recovery invalidate affected sessions. A
runtime cannot change its owner, origin or isolation identity in place.

Schema 1 OIDC configuration/ledgers are not silently converted to local accounts.
They are rejected and preserved. The draft has no automatic migration of existing
user data; explicit ownership mapping, backup and recovery remain required work.

## Remaining boundaries and release acceptance

Disabling an account stops its proxied browser connections. It does **not yet**
stop admitted runtime jobs; local process ownership and durable execution
revocation still need implementation. Signing out intentionally leaves that
owner's schedules running. HTTP/SSE forwarding has 64 MiB upload, 64 per-owner and
512 global request limits, and a one-hour connection limit. Native API/MCP,
webhooks, WebSocket upgrades, MCP App origins and OAuth callbacks still require
protocol integration. None of these gaps may be filled by a cloud isolation
service.

At release pre-flight, run `npm run test:controller` on the current POSIX profile,
then qualify actual installed Windows/Linux candidates in an owned offline
acceptance environment. Do not disconnect the user's active machine or services.

- Cold-start with internet and LAN disabled; enroll/recover accounts, sign in,
  restart, expire/revoke sessions and recover backups using only local resources.
- Check wrong-password and uninitialized/disabled-account denials, persistent
  backoff, password reset during login, exact-origin CSRF, sibling ports/hosts,
  duplicate cookies, malformed forms, oversized uploads and phone sign-in/out.
- Exercise two real owners' list/read/create/edit/delete/run/approve/subscribe/
  export operations and attempts to cross file/process/credential boundaries.
- Verify explicit team resource/dependency grants, edit conflicts, history and
  revocation of already running work. These features are still pending.
- Qualify local TLS/hostname provisioning, native protocols, bounded resource
  use, migration and backup/recovery. Cached online sessions and fixture-only
  endpoint tests cannot satisfy installed-candidate offline acceptance.

Regression and broader acceptance runs are reserved for release pre-flight under
the repository policy. Development checks are typecheck, lint and a non-container
application build. Controller authentication requires no model inference.
