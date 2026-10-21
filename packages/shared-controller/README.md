# Local account controller (development candidate)

FLUJO is local first. Multi-tenancy must work with internet disconnected and LAN
disabled, including cold start, local account enrollment and recovery, private
resources, team permissions, edit locks, history, revocation and restart. No cloud
VM, online identity provider, online DNS or remote isolation lease is required or
permitted as the security boundary. Optional online integrations cannot establish
or maintain that boundary.

This #212/#574 candidate verifies local passwords, provisions owner containers
through a local engine, and persists execution revocation on the local machine.
The earlier OIDC-only draft is superseded. **Full multi-tenant support is still
incomplete:** installed Linux/Windows isolation acceptance, team sharing,
protocol integration, edit leases and history require further work. Keep #212
open. No online isolation implementation is included.

The controller is a separate Node process. It imports no FLUJO execution, MCP,
workspace or encryption modules. Each owner has a distinct browser hostname and
local private runtime, data root, home and service credential. Browser sessions
are opaque host-only cookies. Passwords and administrative bearer credentials are
never supplied to the private runtime through the browser.

## Current development profile

Use Node 22.19+ or 24.2+, a dedicated unprivileged account, one controller
process and SQLite on a local disk. Windows requires an unelevated account and
a fixed local NTFS/ReFS drive; POSIX requires a non-root account. The local Docker engine must run Linux
containers and enforce seccomp, memory/swap and PID limits. The operator account
needs access to its local engine socket; this is trusted administrative access
and must never be granted to a runtime. Native Windows DACL inspection and POSIX
ownership/mode checks protect controller storage. Both profiles still require
installed release qualification. Network filesystems are unsupported. The ordinary
FLUJO launcher remains unchanged.

The local OS boundary must protect each owner's files, processes, credentials and
private listener from the other owners' tools. Two unrestricted Node processes
under the same OS account do not establish that boundary. One VM per user is not
required by the product. Do not expose the controller directory, host home,
operator credentials or another owner's storage to a runtime. OS enforcement and
resource limits need qualification before deployment; an `isolationId` only records
an assignment and does not prove isolation.

Managed runtimes have `--network=none` and no published ports. The controller
relays HTTP directly through the owned child's stdin/stdout and a fixed `docker exec` pipe to
that container's own `127.0.0.1:4200`. The same internal port can be used by every
owner. No LAN bridge, host-network gateway, DNS lookup or online control service
is needed for this channel. No host runtime listener or Unix-socket path is created,
including on Windows; failed pipes cannot fall back to a host TCP endpoint.
Only an explicit local engine socket or Windows named pipe is accepted;
inherited Docker contexts, remote TCP/SSH engines and image pulls are excluded.

Each runtime has three uniquely owned local volumes: data, home and read-only
owner authority. It runs as UID/GID 1000 with a read-only image, private namespaces,
all capabilities dropped, no new privileges, a bounded temporary filesystem and
CPU/memory/PID limits. Host binds, devices, sibling volumes and automatic restart
are refused. Image identity and actual container/volume settings are checked
before admission. The image must already be installed locally with the fixed
runtime helpers; provisioning never fetches or builds it. A local disk is required
for the engine's volume storage as well as the controller ledger.

The older manually assigned loopback-upstream form remains available for
development fixtures. It provides no automatic process revocation or physical
isolation and is not the managed multi-user profile. HTTPS upstream verification
cannot be disabled.

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

`setup` creates a new private installation directory, its state directory and
initial owner configuration. It locates an already installed Docker CLI using
absolute PATH entries, writes a new random credential directly into private
storage, and prints only the config path and owner identifiers. It does not start
the CLI or contact a daemon. The image ID must be an immutable `sha256:` plus 64
lowercase hexadecimal digits; `provision` subsequently verifies that image is
already installed locally. Setup refuses existing directories and never overwrites
an installation. Account names use lowercase ASCII letters, digits and internal
hyphens, start with a letter and have at most 48 characters.

```sh
# The parent directory must already exist and be owned/protected appropriately.
flujo-controller setup /home/operator/flujo-controller alice sha256:REPLACE_WITH_PREINSTALLED_IMAGE_ID
```

```powershell
flujo-controller setup "$env:USERPROFILE\flujo-controller" alice sha256:REPLACE_WITH_PREINSTALLED_IMAGE_ID
```

POSIX config/state directories use mode 0700, files use 0600, and ancestors must
not be group/world writable or symlinks. Windows setup protects new directories
with an owner-only inheritable DACL before creating credential files. Checks
reject foreign access to private storage (including inherit-only grants that
would expose future SQLite files), unsafe ancestor ownership or replacement
rights, reparse points, null DACLs and hard-linked files. SYSTEM and administrative
OS authorities remain trusted. Existing directory ACLs are never rewritten by
setup. Windows file data is flushed before publication, but Node does not provide
directory fsync there; crash/power-loss recovery requires installed qualification.

Keep populated configs and state out of source control. Only the local installation
operator may read the ledger or run enrollment/recovery commands. The resulting
configuration has this shape (paths below illustrate POSIX):

```json
{
  "schemaVersion": 2,
  "stateDirectory": "/home/operator/flujo-controller/state",
  "port": 4280,
  "sessionSeconds": 28800,
  "localEngine": {
    "executable": "/usr/bin/docker",
    "daemon": "unix:///var/run/docker.sock",
    "imageId": "sha256:REPLACE_WITH_PREINSTALLED_IMAGE_ID",
    "memoryMiB": 2048,
    "cpus": 1,
    "pidsLimit": 256,
    "credentialSeconds": 31536000
  },
  "runtimes": [{
    "id": "alice-runtime",
    "actorId": "alice",
    "origin": "https://alice.localhost",
    "upstream": "http://127.0.0.1:4200",
    "credential": "REPLACE_WITH_RANDOM_OWNER_CREDENTIAL",
    "isolationId": "unprovisioned:alice-runtime"
  }]
}
```

Replace the image placeholder with its exact local `sha256:` plus 64 hexadecimal
digits. Generate a separate cryptographically random 32-byte base64url secret per
owner, prefixed with `flo_v1_`, directly into the private configuration. Do not put
it in shell arguments, terminal output or source control. Provisioning installs
only its digest and the required app scopes in the read-only authority volume;
the plaintext stays in the controller's private config. `credentialSeconds` is
bounded to one hour through one year. Expired authority denies admission and stops
the runtime; credential rotation/migration is still pending, so this candidate is
not suitable for unattended production use.

Each owner, runtime, browser hostname, credential, container generation and volume
assignment is unique. Unprovisioned owners may share the placeholder upstream;
they cannot be served before provisioning. Never reuse an owner's browser hostname
for someone else: cookies, browser storage and service workers can outlive a
server session. `provision` fills in the immutable `localRuntime` record and exact
container identity; do not edit these fields to reassign a running owner.

```sh
npm run build:controller
flujo-controller provision /home/operator/flujo-controller/controller.json alice
flujo-controller init /home/operator/flujo-controller/controller.json
flujo-controller password /home/operator/flujo-controller/controller.json alice
flujo-controller serve /home/operator/flujo-controller/controller.json
flujo-controller status /home/operator/flujo-controller/controller.json
flujo-controller disable /home/operator/flujo-controller/controller.json alice
flujo-controller enable /home/operator/flujo-controller/controller.json alice
# With the server stopped, explicitly reconcile all saved start/stop intents:
flujo-controller reconcile /home/operator/flujo-controller/controller.json
```

Use `node bin/flujo-controller.mjs` from a source checkout. Provision every new
owner before `init`. `provision`, `init`, `reconcile` and `serve` hold the same
kernel-backed local process lock; provisioning and initialization require the
server to be stopped. Provisioning journals the generation before mutations,
reuses deterministic volume/container names after interruptions, and publishes
the private configuration atomically only after verifying the new container is
stopped. Retry with the original settings; a lost create reply must not create a
second owner. Changed settings, unexpected existing authority or mismatched
ownership require local recovery while retaining the journal and data. Persistent
volumes are never automatically deleted.

`init` records local accounts but grants no password login until enrollment.
`password` uses a hidden interactive terminal prompt with
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
The local account ledger upgrades from schema 2 to schema 3 for runtime intent and
provisioning journals; config schema remains 2.

## Execution revocation and recovery

`disable` commits account/session revocation and a new durable stop intent before
contacting the local engine. The sole supervisor checks the exact container,
image and owner identity, kills the owned container's processes and observes its
terminal state. A stop acknowledgement alone does not count as confirmation.
Removed owners retain stop intents in the ledger even after their config entry
is removed. Re-enabling never restores old sessions and waits for fresh runtime
verification before browser admission.

The CLI prints desired state, generation, phase and last verification time.
Exit code 2 means pending, failed, superseded or unmanaged execution; it does not
mean a job was stopped. While the server owns the lock, the CLI waits up to 20
seconds for that exact intent, then leaves the supervisor responsible for retries.
With the server stopped, the command drives convergence itself. Unavailable
engines produce an uncertain state, not invented exit evidence.

Managed admission requires a confirmed running observation less than 30 seconds
old and unexpired authority. The supervisor refreshes observations and checks
resource enforcement, volume ownership, container settings and the private
authority digest. Failed running checks also attempt to stop that exact owned
container; a different identity is never a license to kill another container.
Restart discards stale observations and preserves disabled accounts. Signing out
or shutting down the controller intentionally leaves enabled owners' schedules
running. Administrative disable is the execution-revocation action. Persistent
effects already committed by a job are not rolled back or automatically replayed.

## Remaining boundaries and release acceptance

HTTP/SSE forwarding has 64 MiB upload, 64 per-owner and 512 global request limits,
and a one-hour connection limit. Managed transport additionally caps active pipes
at eight per owner and 64 globally. Cancelled requests retain their process slot
until the owned child actually exits. Streams recheck authority each second;
shutdown waits for child exit and reports unconfirmed exit instead of treating a
kill request as success. Native API/MCP,
webhooks, WebSocket upgrades, MCP App origins and OAuth callbacks still require
protocol integration. None of these gaps may be filled by a cloud isolation
service.

The networkless runtime currently cannot call internet providers, sibling
containers, host-local model servers or download new tools. Local tools already
in its image/volumes can run. A separately authorized local capability broker is
pending for optional external integrations and host model services; it must not
weaken owner isolation or become an online prerequisite. Persistent disk quotas,
full process-tree/pipe exhaustion qualification, credential rotation and local
TLS installation also remain pending.

At release pre-flight, run `npm run test:controller` through flujo-bash on both
unelevated Windows and unprivileged POSIX profiles, then qualify actual installed
Windows/Linux candidates in an owned offline
acceptance environment. Do not disconnect the user's active machine or services.

- Cold-start with internet and LAN disabled; enroll/recover accounts, sign in,
  restart, expire/revoke sessions and recover backups using only local resources.
- Check wrong-password and uninitialized/disabled-account denials, persistent
  backoff, password reset during login, exact-origin CSRF, sibling ports/hosts,
  duplicate cookies, malformed forms, oversized uploads and phone sign-in/out.
- Exercise two real owners' list/read/create/edit/delete/run/approve/subscribe/
  export operations and attempts to cross file/process/credential boundaries.
- Qualify the real engine's inspection fields, seccomp, mounts, UID, namespaces,
  CPU/memory/PID bounds, no-network behavior and offline image availability.
  Check native ACL/ancestor refusal, offline local setup, pipe failures with no
  network fallback, buffered response integrity and pipe exhaustion. Interrupt
  provisioning after each journal step and before/after config publish.
  Disable during a running tool/stream and during controller/engine failure;
  require observed process exit without touching the other owner's jobs.
- Verify explicit team resource/dependency grants, edit conflicts, history and
  revocation of already running work. These features are still pending.
- Qualify local TLS/hostname provisioning, native protocols, bounded resource
  use, migration and backup/recovery. Cached online sessions and fixture-only
  endpoint tests cannot satisfy installed-candidate offline acceptance.

The runtime regression sources include policy drift, unconfirmed start/stop,
stale intent, wrong-owner protection and lost-create-response recovery using an
engine fixture. Native storage, setup and real child-stdio/HTTP-parser regression
sources cover platform boundaries without claiming actual container/kernel isolation.
Regression and broader acceptance runs are reserved for release pre-flight under
the repository policy. Development checks are typecheck, lint and a non-container
application build. Controller authentication requires no model inference.
