# Private-owner controller (development candidate)

This is the first implementation batch for #212/#574. It connects verified OIDC
identities to existing, separately isolated FLUJO installations. It is **not yet a
qualified shared/public deployment**: Linux candidate-artifact acceptance and the
physical runtime boundary are still required. Team sharing, team execution, edit
leases and change history are not implemented in this batch. Keep #212 open.

The controller is a separate Node process. It imports no FLUJO execution, MCP,
workspace or encryption modules. Each owner has a different browser origin and a
different private runtime, data volume, home directory and service credential.
The browser receives an opaque host-only session cookie. It never receives the
controller's OIDC secret or the runtime's administrative bearer.

## Deployment profile

Use Node 22.19+ or 24.2+, a dedicated unprivileged POSIX account, one controller
process and SQLite on a local disk. Windows hosting and network filesystems are
not supported. The ordinary FLUJO launcher remains the default and is unchanged.

Provision one VM or otherwise qualified OS-isolated container per owner. Two
processes under the same unrestricted host account are insufficient. Do not mount
the controller directory, Docker socket, another owner's files, shared host home,
or operator credentials into any runtime. Give each runtime distinct writable
data and home directories, its own owner policy, CPU/memory/process/storage limits
and a private listener. Runtime tools must not reach another runtime's private
listener or the controller's state. An `isolationId` in configuration records the
operator's assignment; it does not verify those controls.

The runtime must require its existing owner bearer and accept its public origin
through the existing public exposure mode and owner browser-origin configuration.
Set `FLUJO_OWNER_BROWSER_ORIGIN` to that runtime's exact HTTPS origin. Keep its
actual listener private. The controller forwards that Host and the original
same-origin browser Origin, and supplies the runtime's owner credential. It does
not use worker mode or bypass the runtime's owner authentication.

Terminate TLS in a trusted reverse proxy on the controller host, routing only the
configured owner hostnames to `127.0.0.1:4280`. Preserve the original Host. Do not
cache authenticated responses or log callback query strings/cookies. The
controller ignores forwarded identity and forwarding headers; it accepts no
public bind address. There is no HTTP browser/development bypass.

Configure the OIDC provider with a confidential client and one exact redirect URI
per owner origin: `https://alice.example.com/_account/callback`, etc. The issuer
must support authorization code flow, PKCE S256, signed ID tokens and HTTPS.
Bind the provider's immutable subject to the owner, never an email address.

## Configuration and commands

Create a mode-0700 private config directory and a separate mode-0700 private state
directory, owned by the controller account. Ancestors must not be group/world
writable or symlinks. Config and optional private-CA files must be mode 0600,
owned by that account, with no links. Supply secrets from the deployment's secret
store; do not commit the populated configuration.

```json
{
  "schemaVersion": 1,
  "issuer": "https://identity.example.com",
  "clientId": "registered-client-id",
  "clientSecret": "FROM_SECRET_STORE",
  "stateDirectory": "/srv/flujo-controller/state",
  "port": 4280,
  "sessionSeconds": 28800,
  "runtimes": [{
    "id": "alice-runtime",
    "actorId": "alice",
    "subject": "immutable-subject-from-issuer",
    "origin": "https://alice.example.com",
    "upstream": "https://alice-private.example.internal:4200",
    "credential": "REPLACE_WITH_ISSUED_OWNER_CREDENTIAL",
    "caFile": "/srv/flujo-controller/config/private-ca.pem",
    "isolationId": "immutable-vm-or-container-id"
  }]
}
```

`caFile` is optional when the upstream uses publicly trusted TLS. HTTP upstreams
are accepted only at literal loopback addresses. Certificate verification cannot
be disabled. Credentials must use the existing `flo_v1_` owner token format and
have the scopes needed by the owner's app. Each owner/subject/origin/upstream/
credential/isolation identity must be unique. Never reuse an origin for a new
owner; browser storage and service workers are origin-scoped.

```sh
npm run build:controller
flujo-controller serve /srv/flujo-controller/config/controller.json
flujo-controller status /srv/flujo-controller/config/controller.json
flujo-controller disable /srv/flujo-controller/config/controller.json alice
flujo-controller enable /srv/flujo-controller/config/controller.json alice
```

From a source checkout, use `node bin/flujo-controller.mjs` in place of the
installed command. These commands never print credentials, identity claims or
OIDC responses. Visit the owner's HTTPS origin and sign in. The account control
in the desktop navigation or phone menu opens `/_account`, which offers
sign-out and a link back to FLUJO, including on narrow phone screens.

The SQLite ledger preserves immutable identity bindings, hashed session IDs,
pending one-use PKCE attempts and redacted lifecycle audit events. Disabled actors
stay disabled across restarts and configuration reloads. Enabling an actor does
not restore old sessions. Removing a runtime from configuration revokes its
sessions on restart. Changing upstream, credentials, OIDC configuration or session
duration also invalidates sessions. Changing the actor's issuer/subject or a
runtime's owner/origin/isolation identity is rejected. Use an explicitly planned
new runtime/owner migration instead.

## Current boundaries and release acceptance

Authentication uses signature, issuer, audience, expiry, nonce, state and PKCE
validation through `openid-client`. Mutations require the exact browser Origin;
sibling origins are rejected. Session authority is read from the current ledger
on every request and upload chunk and at one-second intervals during streams.
Disabling an actor closes proxied connections; it does not stop already admitted
runtime jobs. Suspend that owner's runtime separately when removing execution
access. Signing out intentionally leaves that owner's scheduled jobs running.
Runtime execution revocation and team leases require the later admission work.

The controller supports HTTP requests, streaming responses and SSE, with 64 MiB
uploads, 64 concurrent requests per owner, 512 globally and a one-hour connection
limit. Native API/MCP credentials, unauthenticated webhooks, WebSocket upgrades,
MCP App sandbox origins and cross-origin OAuth POST callbacks need separate
protocol integration; this candidate does not claim those journeys. No old data
is migrated automatically. Preserve a consistent backup and verified key recovery
before any operator-directed migration.

Release pre-flight must run `npm run test:controller` on the supported POSIX
profile, then exercise two real isolated candidate runtimes and a test OIDC issuer:

- Valid login, PKCE/state/nonce/signature/issuer/audience/expiry rejection, callback
  replay, wrong-account login, unknown hosts and forged identity/forwarding headers.
- Two users independently list, read, create, edit, delete, run, approve, subscribe
  and export; guessed IDs and workspace selectors never cross the runtime boundary.
- Exact-origin CSRF, sibling-origin attacks, duplicate cookies, redirect handling,
  upload bounds, phone login/logout, expiry and disabled-actor stream closure.
- Browser cache/storage separation, controller restart, credential rotation,
  config removal/reintroduction, immutable binding rejection and durable revocation.
- Physical file/process/environment/network/credential isolation, bounded resource
  use, backup/recovery and the explicitly unsupported protocols before expanding
  the deployment claim. Do not substitute mock endpoints for this acceptance.

The test command is reserved for release pre-flight under the repository's
validation policy. Development checks are typecheck, lint and the non-container
application build. No model inference is needed by the controller.
