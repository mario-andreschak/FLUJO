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
incomplete:** installed Linux/Windows isolation acceptance, shared resource
execution, remaining native editors, dependency authorization and protocol integration require further work. Keep #212
open. No online isolation implementation is included.

The controller is a separate Node process. It imports no FLUJO execution, MCP,
workspace or encryption modules. Each owner has a distinct browser hostname and
local private runtime, data root, home and service credential. Browser sessions
are opaque host-only cookies. Passwords and administrative bearer credentials are
never supplied to the private runtime through the browser.

## Local teams

From **Your account → Your teams**, a signed-in account can create a team and
invite another enrolled local account by its exact account ID. The recipient sees
the invitation in their own account page and accepts or declines it there. No
email, account directory, online identity or network service is involved. Pending
invitations expire after seven days; they grant no access. The creator manages
invitations, membership and the team name. Members can leave. The creator can
archive a team, which removes all memberships and pending invitations while
retaining its local record. Rejoining requires a fresh invitation and acceptance.

This implements the membership journey. Joining a team does not publish a
private Model, MCP server, Flow, Chat or Execution, authorize a cross-owner runtime
request, or expose credentials. The document library below uses the local
membership authority; a client-provided team ID is never proof.

Schema 9 retains teams, invitation state, monotonically increasing membership
generations and the latest 200 membership events per team in the private SQLite
ledger. Forms carry the displayed team generation, so a stale member-management
page cannot overwrite a newer change. Invitation identifiers rotate on reissue,
are bound to the intended recipient, and are cleared on acceptance, decline,
withdrawal or archive. Authority witnesses include the exact parent session and
team generation; every check rereads SQLite. Removal followed by reinvitation,
logout, password recovery and account revocation cannot revive an older witness.
Restarts preserve memberships and do not require online refresh.

Membership reads and writes run in transactions with current session checks.
Account pages enforce exact Origin admission, no-store responses, no embedding,
bounded form decoding and a post-upload authority check. Team forms never reach
a private runtime. At most 30 mutations per account per minute and the controller's
ordinary in-flight limits apply. Limits are 256 active teams per installation,
32 created by one account, 128 active or invited members per team and 32 pending
invitations per recipient. Retained directory limits are 4,096 teams overall and
512 created by one account, including archives. Reaching a retained limit requires
operator attention; archiving does not erase records to bypass that bound.
Membership activity is not resource revision history.

Release qualification must exercise two real offline browser sessions, consent,
stale forms, logout during uploads, membership removal and restart with internet
and LAN disabled. The SQLite and HTTP regression sources do not establish that
installed acceptance.

### Shared documents, edit locks and revision history

**Your teams → a team → Shared documents and revision history** stores explicitly
submitted JSON documents locally. Kind labels cover Models, MCP, Flows, Chats and
Executions. Generic documents are passive snapshots; typed model configurations
also have the native editing and local execution journeys below. **Shared MCP,
Flow, Chat and Execution editors and dependency access remain incomplete.** This library does not
satisfy Tier 1 by itself. Generic JSON is structurally bounded, not validated
against each native resource schema. It does not discover private resources, dereference dependency
IDs, import keyrings, execute pasted commands, or confer runtime permissions.
Generic document content is shared verbatim after JSON formatting, including any
secret the submitter includes. The native model path uses a strict field allowlist;
the remaining native publication paths still need secret-safe serialization and
explicit dependency selection before being enabled in ordinary app editors.

Every current team member can view, download and edit a submitted document. The
create form requires explicit sharing consent. Each document has one current edit
lease, acquired against its displayed version in an immediate SQLite transaction.
The opaque lease is stored only as a hash and bound to the exact parent session,
actor, membership generation and increasing fence. Its lifetime is at most 120
seconds, bounded by the session expiry. The page renews it every 20 seconds;
without JavaScript it expires after 120 seconds. Another tab, including one with
the same account, cannot acquire a second live lease. A save checks current
membership, session, lease, fence and version in the same transaction as the new
revision and releases the lease. Team renaming and unrelated invitations do not
evict the editor. Removal/rejoin, logout, password recovery, account disablement,
expiry and controller restart cannot revive the old lease. Startup reconciliation
clears leases and advances their fences without removing documents or history.

Revisions retain author, timestamp, name, content, content digest and source
revision for restores. Restoring requires confirmation, an unchanged displayed
version and no live editor; it appends a revision instead of overwriting history.
Validation failures and rolled-back writes preserve the saved version and lock.
The page keeps a failed draft in memory, offers download and warns before leaving
an edited form. A failed non-JavaScript submission echoes only the submitted
name/content, escaped, without hidden lease fields or fresh reads after a denial.
A lost response has an ambiguous outcome: check current history before retrying.
Closing the tab without retaining a draft can still lose unsaved work; drafts are
not persisted to browser storage.

Limits are 1 MiB per formatted document, depth 64, 50,000 JSON values, 1,000
documents per team and 1,000 revisions per document. Revision payload budgets are
128 MiB per team and 512 MiB per installation; these exclude SQLite/index/WAL
overhead and do not constitute a filesystem disk quota. History is never silently
pruned. Archives retain their payload budget. A reached limit stops new writes
with a recoverable error and requires a deliberate operator retention/export
decision. HTTP forms are capped at 4 MiB and 10 seconds, with exact field sets,
duplicate/encoding rejection, exact-origin admission, no-store and a nonce-based
script policy. Resource requests have a separate pool of four per account and
16 overall; a slot lasts through response drain, with a 20-second request/response
lifetime. The 30-per-minute team mutation budget includes lease renewals.

Release-only regression sources in `test/team-resources.test.mjs` and
`test/resource-page.test.mjs` cover separate SQLite connections, stale saves,
membership/session loss, restart, schema upgrades, restore history, quota and
write failure atomicity, consent, escaped content and draft recovery. They are
not a substitute for native two-user offline browser acceptance or native editor
integration. Schema 6 upgrades create an empty document library and preserve
existing memberships/accounts; they do not publish private runtime data.

### Native team model configuration

In controller mode, **AI Setup → Team models** or **Your teams → a team → Team
models** opens `/teams/models`. Select a current team, choose **Share a model**,
select a private model, review the projected configuration in the existing model
editor, and explicitly share it with the named team. This creates a team resource;
the private original remains unchanged. Every current member can open the same
configuration in the model editor under the durable edit lease, save a new
revision and open its local revision history/download/restore page.

The browser-safe `shared-model.ts` protocol defines `flujo.model.v1` and a bounded,
strict allowlist of native configuration fields. Publication excludes `ApiKey`,
private IDs, folders, favorites and unknown extension fields. Owner credential
bindings and fallback routing aliases are rejected until their dependency grants
exist. Endpoints containing user-info, query parameters, fragments or non-HTTP(S)
schemes are rejected. Prompt/description text is deliberately shared as written;
this is not a detector for secrets manually embedded in free text. The controller
independently validates typed documents at creation, save and restore. Schema 8
records their immutable format so a later JSON-form/API edit cannot remove the
format marker to bypass credential rejection. A transactional schema 7 upgrade
retains existing documents as generic JSON, even if their content contains a
format-like tag. It neither promotes old JSON to executable/native configuration
nor changes its history.

The shared editor disables API-key/global-credential binding controls, provider
discovery (including background CLI catalogue refresh), private prompt-builder
actions, AI model-form actions/context and private workspace saves. It uses the
same existing configuration fields with plain prompt-text editing. Team reads and
form-encoded mutations use the controller's exact-origin JSON representation of
the account/resource routes and retain its authorization/limits. The browser
renews its own lease, disables saving after definitive revocation/expiry, preserves
a failed draft and offers a local credential-excluded draft download. Closing an
editor requires a discard decision; release on close/unmount is best effort and
the local expiry remains authoritative. Drafts are not persisted in browser storage.

This delivers native model **configuration sharing/editing**. The separate local
execution permission and relay described below do not contact providers while
editing, and existing private model setup behavior is unchanged. Linking shared
models into native Flows/Chats uses the admitted references described below. Release-only
HTTP/SQLite and React regression sources cover projection, forged secret fields,
format downgrade, legacy migration, provider-discovery suppression, shared saves
and denied-save draft recovery. Native offline browser acceptance is still pending.

### Explicit team model execution permission

**Team models → Execution permission** delegates one already configured local
model service to the whole team for one shared model revision. Only the signed-in
account's current `modelGrants` are selectable. The model name must already be
granted, and this path supports OpenAI Chat Completions compatible configurations
(`openai`, `ollama` or `litellm` with the `openai` adapter). It cannot authorize a
caller-supplied destination, another account's grant, CLI/subscription adapter or
remote fallback. The model's stored base URL is never the execution destination.
Enabling execution requires explicit consent; all current members can disable it.
Stale revision/permission generations cannot replace a newer decision. The latest
200 permission events are visible alongside the full configuration history.

Schema 9 records the source runtime revision, source grant generation, granting
member generation and local account authentication revision. Its upgrade preserves
existing model/history data and creates no execution grants. Model save/restore,
source grant disable/re-enable, grantor removal/rejoin or password recovery require
explicit reauthorization. Runtime requests derive the requester from its fixed
owner pipe; they never accept an actor or credential from request data. Each
admission captures the current recipient membership/authentication generation and
shared revision. Membership changes, source revocation and runtime retirement end
active requests; rejoining cannot revive an old stream admission. A new accepted
member can make a fresh request while the team's permission is current.

The existing networkless owner model relay exposes:

```
http://127.0.0.1:4290/teams/<team-id>/<resource-id>/revisions/<version>/v1/configuration
http://127.0.0.1:4290/teams/<team-id>/<resource-id>/revisions/<version>/v1/models
http://127.0.0.1:4290/teams/<team-id>/<resource-id>/revisions/<version>/v1/chat/completions
http://127.0.0.1:4290/teams/<team-id>/<resource-id>/revisions/<version>/v1/embeddings
```

These are inside-owner loopback addresses, not browser/host URLs. Configuration
and catalogue reads use GET; completion/embedding requests use POST. Configuration
returns only the validated shared document and catalogue returns only the one
delegated model. The host's endpoint, token and CA paths are never returned.
Existing request/body/response limits, chunk credits and live authority checks
apply. Runtime model channels are capped at 64, requests at four per channel and
16 per controller. Managed owners also receive catalogue-only channels before
any grant exists; an empty catalogue confers no execution authority. At capacity,
execution-granted channels take priority over catalogue-only channels. Retired
channels keep their slot until the child process is observed to exit.

### Shared models in native model selection and execution

The application model catalogue includes admitted shared models, labelled with
their team name, in Flow/Chat model selection. Private model settings and the
publication source picker explicitly request private scope. Shared references use
`team-model:<team-id>:<resource-id>`; private add/update/delete refuse those IDs or
shared-reference metadata. No shared projection is written into `models.json`.
Private fallback policies and original-owner credential rebinding do not accept
shared model references; those features require their own dependency admission.

The owner-pipe `GET /teams/models[/after/<resource-id>]` paginates eight admitted
selector entries at a time. It excludes prompts and endpoints.
`GET /teams/<team-id>/<resource-id>/current` resolves the current full configuration and
permission generation. Each response rechecks the current authority while being
sent. The application bounds catalogue retrieval to 20 seconds and 32 MiB, each
response to 2 MiB, and rejects repeated/non-advancing cursors. Failed pagination
discards partial shared results while retaining private choices and returning an
explicit shared-unavailable flag. Guided selection preserves existing bindings
on failure and can refresh without discarding the unsaved flow. Validation treats
an incomplete catalogue as unavailable rather than calling those bindings deleted.
Quick Chat construction, server-side Flow validation and Flow/MCP authoring
discovery use this same catalogue. An explicit private-model selection remains
usable during a team-catalogue outage; alias-based selection waits for complete
discovery to avoid silently selecting a same-named private model. The public
`/v1/models` endpoint lists shared models as `model-team-model:<team>:<resource>`
and exposes only identifiers, with a header indicating unavailable team discovery.

Before executing a Process/Chat model, catalogue admission resolves its shared
reference and captures the detached configuration and permission generation. It
rechecks both before dispatch. The generated transport URL is fixed to the owner
loopback relay and includes `/revisions/<version>/grants/<generation>/v1`; it never
uses the shared document's stored endpoint. The host refuses a generation captured
before revocation/rejoin or permission replacement. The SDK receives an inert
local relay value, not an API key or login. Native model testing, direct completion,
embeddings and model-assisted flows use the same pinned transport; no host
credential is copied or decrypted by the recipient. Ordinary installations do not
query this relay. Regression sources cover catalogue paging, current resolution,
private/shared separation, denied admission and prepared-request revocation.
Installed offline browser and full execution acceptance are still release work.

## Current development profile

Use Node 22.19+ or 24.2+, preinstalled OpenSSL 3, a dedicated unprivileged account, one controller
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

New installations serve HTTPS directly on `127.0.0.1:4280`, using separate names
such as `https://alice.localhost:4280` and `https://bob.localhost:4280`. Modern
localhost-aware browsers resolve these names to loopback without online DNS;
qualify the supported browser's cold resolution with LAN disabled. The listener
never binds a LAN interface. Different ports on one hostname cannot separate
owners' cookies and are rejected. No public DNS resolver, ACME service or
certificate-validation bypass supplies the offline profile.

`tls-init` creates and pins a private installation CA, then issues a server
certificate for enrolled owner hosts and, for managed owners, their single-label
app namespaces (`*.alice.localhost`). It never signs a general `*.localhost`
wildcard. `tls-trust` is an explicit operator action to trust
only its public CA in the current Windows user's Root store or a Linux browser
NSS database. These commands never transmit a private key or request an online
certificate. The CA has a localhost DNS name constraint and no subordinate CA
authority; protect its private key as installation authority. Browsers and the
controller normally run under the same local desktop account; other OS accounts
or devices need the public CA installed in their own trust store.

The older configuration without `tls` still requires a trusted local TLS proxy
forwarding the configured browser Host. Enrolled origins are immutable: enabling
direct TLS cannot silently change their port or hostname. The proxy must not cache
authenticated responses or log cookies, sign-in bodies or private URLs. Exact
browser Origin checks apply to mutations, and forwarded identity is ignored.

## Configuration and local enrollment

`setup` creates a new private installation directory, its state directory and
initial owner configuration. It locates an already installed Docker CLI using
absolute PATH entries, locates OpenSSL 3, writes a new random credential directly into private
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
  "tls": {
    "directory": "/home/operator/flujo-controller/state/tls",
    "executable": "/usr/bin/openssl"
  },
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
    "origin": "https://alice.localhost:4280",
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
the runtime. Use the local rotation commands below to renew it. Migration and
installed acceptance remain pending; this candidate is not ready for production.

Each owner, runtime, browser hostname, credential, container generation and volume
assignment is unique. Unprovisioned owners may share the placeholder upstream;
they cannot be served before provisioning. Never reuse an owner's browser hostname
for someone else: cookies, browser storage and service workers can outlive a
server session. `provision` fills in the immutable `localRuntime` record and exact
container identity; do not edit these fields to reassign a running owner.

```sh
npm run build:controller
flujo-controller tls-init /home/operator/flujo-controller/controller.json
flujo-controller tls-trust /home/operator/flujo-controller/controller.json
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

## Local TLS trust and recovery

Windows trust uses the current unelevated user's native certificate store; it
does not add a machine-wide root. Linux trust requires preinstalled NSS
`certutil`. It uses an existing `~/.pki/nssdb`, otherwise the Chromium M146+
default `~/.local/share/pki/nssdb`. An optional absolute database path under the
current user's home selects another browser profile, including an existing
Firefox NSS database. Existing files and permissions are preserved; unsafe,
redirected or externally writable stores are refused. macOS automatic trust
installation is not implemented yet; its native certificate manager can import
the public CA. Browser trust changes may require a browser restart.

`tls-init` prints the public CA path, its SHA-256 fingerprint and the leaf expiry;
it never prints a private key. Verify the installation fingerprint when moving
the public certificate between accounts/devices. Do not copy the state directory
or private keys to a client. `tls-untrust` removes only that exact pinned CA from
the selected user store and verifies the result; it leaves certificates, data and
account state available for recovery. It is not an account-revocation command.

CA identity is journaled before issuance and pinned after verification. A retry
after interrupted initialization reuses the saved key and certificate. Missing
or inconsistent pinned authority fails closed; restore the matching private TLS
directory and `root.json` from a protected backup instead of generating an
unrelated replacement. Leaf renewal publishes `current.json` only after checking
the signature, private key, exact hostnames, usage and validity. Previous leaf
files and interrupted private candidates are retained for recovery.

Leaf certificates last 90 days. The live controller checks every six hours and
renews locally when less than 14 days remain, then updates HTTPS without changing
account sessions. Startup also renews an expired/near-expiry leaf using the same
CA and local tool. `tls-renew` forces renewal with the server stopped. A failed
renewal retains the previous valid certificate; expired material blocks request
admission and existing streams. Shutdown waits for an in-progress signing command
before releasing the controller lock. The ten-year CA is never silently replaced;
CA expiry, key loss or compromise requires explicit local recovery and new trust.
Installed browser trust, name resolution and power-loss recovery still need
release qualification; regression sources alone cannot establish those results.

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
The local account ledger upgrades from schema 2/3/4/5/6/7/8 to schema 9 for runtime intent,
provisioning, credential-rotation journals, revocable model grants, local teams and shared documents;
config schema remains 2. Earlier
controller binaries reject the newer ledger rather than ignoring pending work.

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

## Local runtime credential rotation

Stop the controller before rotating a managed owner's service credential. The
command uses the same exclusive local process lock as provisioning and serving.
Browser access for all owners is unavailable during this maintenance; other
owners' existing runtime jobs continue:

```sh
flujo-controller rotate /absolute/private/config.json alice
flujo-controller status /absolute/private/config.json
# After an interrupted command or lost final reply:
flujo-controller resume-rotation /absolute/private/config.json alice
```

Rotation revokes that owner's browser sessions and records a durable stop intent
before contacting the engine. It observes the exact owned container stopped,
checks its immutable image, isolation and three volume identities, then runs a
fixed UID 1000 helper with only the authority volume mounted writable. The helper
has no network, host binds, data/home volume access or additional capabilities.
It uses the already installed image and an atomic private authority publication.
The controller publishes the matching private configuration and commits the new
digest/revision to SQLite before requesting a restart. Browser access requires a
fresh successful runtime/authority observation. Account enablement, passwords,
owner/container/volume identity and persistent data remain intact. A concurrent
disable supersedes the operation and is preserved on recovery.

The journal phases are `prepared`, `stopped`, `authority-updated`,
`config-published` and `complete`. A pending rotation blocks startup, provisioning,
another owner's rotation and account enable; local disable and status remain
available. `rotate` resumes an existing pending operation. After completion it
deliberately starts a new rotation; use `resume-rotation` after a lost final reply
to retain the completed credential. Completed rotation and confirmed execution
are separate: exit 2 reports an unconfirmed final runtime state.

Preserve the private `rotation-<operationId>.json` candidate alongside the ledger
until recovery is complete. Candidates contain credentials and must receive the
same protection as the main configuration. The journal, helper stdin and CLI
output contain only digests/metadata. Conflicting operator config edits are never
overwritten: restore the exact source or target configuration to resume. Lost
helper replies require inspection and observed exit of the exact journaled
helper; an unknown or still-unconfirmed helper leaves access closed. If an
interrupted candidate expires, recovery finishes it stopped and performs one fresh
local rotation before requesting a restart. No online credential issuer, lease,
identity service or image download is used. Native crash/power-loss and engine
acceptance remain release gates; fixtures cannot establish those guarantees.

## Host-local model services

A managed owner can use an explicitly granted, already installed local model
service while its container remains networkless. Add `modelGrants` to that
owner's runtime entry in the private controller config, then restart the
controller. The following example grants only a model that the operator has
already installed and approved on the host:

```json
"modelGrants": [{
  "id": "local",
  "endpoint": "http://127.0.0.1:11434/v1",
  "models": ["your-installed-model-name"]
}]
```

Endpoints must be canonical HTTP(S) URLs with an explicit non-default port, the
literal loopback address `127.0.0.1` or `[::1]`, and exactly `/v1`. Hostnames,
LAN/internet addresses, credentials in URLs, queries and fragments are rejected.
An optional `bearerFile` contains the service token in private host storage; an
optional `caFile` pins a local HTTPS service's trust material. Neither file nor
the host endpoint is sent into the owner container. The operator must trust the
configured local service with that owner's submitted model inputs. Granting a
service does not authorize its administration, model downloads or arbitrary URLs.

Inside that owner's FLUJO, use the existing local/Ollama connection option with
server URL `http://127.0.0.1:4290/grants/local` (the wizard appends `/v1`), or edit
an existing local model's base URL to
`http://127.0.0.1:4290/grants/local/v1`. Select an exact granted model name and the
OpenAI-compatible adapter. This address is inside the private container; it is
not a host listener. The local profile uses a non-secret placeholder key; never
copy the host service token into a model. The configured catalogue lists only
that owner's granted models. Listing models is not proof that the host service
or model is ready; its connection test performs an actual model request.

The controller launches a fixed UID 1000 helper through the exact owned exec
pipe after fresh runtime verification. It relays catalogue, chat completions
(including SSE/tool-call messages and inline images) and embeddings. Each
request is bound to its owner, grant revision/generation and model allowlist.
Caller headers and URLs cannot select host credentials or destinations. The
relay follows no redirects, forwards no host cookies/diagnostics, and rejects
external image URLs, external schema references, unknown operations and
unsupported body extensions. It does not retry or replay requests; a caller's
own configured retry behavior remains its responsibility. Native subscription
adapters, Responses/audio/image-generation APIs and internet providers are not
carried by this local-model channel yet.

```sh
flujo-controller disable-model /absolute/private/config.json alice local
flujo-controller enable-model /absolute/private/config.json alice local
```

Revocation is durable and survives restarts/reconfiguration. Re-enabling creates
a new grant generation; it cannot revive an older in-flight stream. Requests
recheck authority before sends/chunks and at one-second intervals, including
while waiting for response credit. Account disable, expired runtime authority,
lost observations and shutdown also close the relay. Closing a host connection
does not prove that a model service stopped inference already accepted; the
service remains responsible for its own cancellation/resource enforcement.

Framing, body reads and pipe writes are bounded. There are at most 64 owners with
relay grants, four active requests per owner and 16 upstream requests globally.
Requests are limited to 8 MiB, responses to 64 MiB, and channel input to about
64 MiB/4,096 frames per ten seconds. Chunk acknowledgements apply backpressure;
unconfirmed child exits retain their channel slot. Requests retain the normal
five-hour model ceiling. A helper loses its listener within ten seconds without
controller heartbeats; restart uses bounded backoff and never switches to a
host-network path. Services, helpers and models must already be installed:
no DNS, image pull or download is needed for this channel. Actual Docker/stdin
failure behavior and cold offline model journeys still require release acceptance.

## Local MCP App rendering

With direct local HTTPS, a verified MCP App opens at
`https://app<resource-hash>.alice.localhost:4280/sandbox.html`. Another owner's
copy has a different hostname. The runtime still checks workspace, server,
resource identity and consent before discovery. The controller replaces the
runtime's token with a single-use, 60-second launch ticket tied to that owner
session and exact app origin. Concurrent mounts receive separate tickets.
Restart discards tickets, and logout, account/runtime revocation or expired
authority prevents admission and cuts an in-flight response. Already rendered
content is not erased by revocation; subsequent tool calls require the parent's
current authenticated session.

Only an iframe navigation from the exact owner page can consume a ticket. The
controller uses a fixed owner exec pipe to container loopback port 4201, without
publishing a container port or enabling networking. The sandbox receives no
owner bearer, parent session cookie or caller identity headers. Its CSP limits
embedding to that owner, retains the content policy and disables workers; the
managed runtime pins its embedder/port and ignores the allow-all escape hatch.
The app hostname never routes ordinary FLUJO APIs, registration requests or an
arbitrary URL to the container. Up to 64 pending launches per owner and 4,096
globally share the existing bounded pipe/request quotas.

This carries inline MCP Apps and their parent-mediated tool calls, including
the terminal's tool-call polling. A successful launch also sets a separate,
host-only `__Host-flujo-app` cookie with Secure, HttpOnly and SameSite=Strict.
It authorizes only this app's registered sidecar routes on the fixed sandbox
listener, never the owner's application API. Each app session is bound to its
parent session and expires with it; concurrent mounts reuse the app session,
while launch tickets remain single-use. Restart discards app sessions. There
are at most 64 active app sessions per owner and 4,096 globally.

Sidecar HTTP requires same-origin browser metadata and an exact app Origin for
mutations. WebSocket handshakes require that exact Origin too. Every request,
response chunk and established stream checks current local authority; logout,
account/runtime revocation or lease retirement cuts active connections. The
controller also ends upgraded connections when its listener closes, before
waiting for owned pipe processes to exit. The
runtime still requires proof of control of the target and a path/method manifest.
Registration/replacement/eviction now closes already-established HTTP/WebSocket
connections as well as removing their routes. The broker caps connections at
64 per registered app and 512 globally, in addition to controller/pipe bounds.

Sidecar cookies may remain on their own app hostname; Domain attributes and
controller cookie names are rejected, and controller cookies are stripped from
requests. Forwarding hints name only the pinned public app origin. Content CSP
is preserved while frame ancestors are restricted to the owner/app chain;
service-worker registration is denied. Dedicated workers can use registered app
assets. Redirects stay on that app origin. HTTP uploads/responses are bounded
at 64 MiB. WebSockets have a ten-second handshake, two-minute inactivity,
one-hour lifetime and 256 MiB per-direction limit, and do not negotiate compression.
Both transports retain backpressure and use the existing owned pipe quotas.

No shared browser origin, cloud gateway or online DNS service supplies this
path. Local CA trust, nested localhost resolution/cookie behavior and actual
browser/terminal/sidecar operation with both internet and LAN disabled remain
release gates. Cookie semantics follow the browser's [host and same-site
rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie);
the controller additionally enforces exact origins rather than relying on SameSite alone.

## Remaining boundaries and release acceptance

HTTP/SSE forwarding has 64 MiB upload, 64 per-owner and 512 global request limits,
and a one-hour connection limit. Managed transport additionally caps active pipes
at eight per owner and 64 globally. Cancelled requests retain their process slot
until the owned child actually exits. Streams recheck authority each second;
shutdown waits for child exit and reports unconfirmed exit instead of treating a
kill request as success. Native API/MCP,
webhooks, non-App WebSocket upgrades and OAuth callbacks still require
protocol integration. None of these gaps may be filled by a cloud isolation
service.

The networkless runtime cannot directly call internet providers, sibling
containers or download new tools. Local tools already in its image/volumes can
run, and explicit model grants use the local relay described above. Capability
support for optional external integrations and native subscription adapters is
still pending; it must not weaken owner isolation or become an online prerequisite. Persistent disk quotas and
full process-tree/pipe exhaustion qualification remain pending.
Native TLS trust and browser/offline installation qualification
remain release gates.

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
  Interrupt rotation before/after authority publication, config publication and
  ledger commit; lose the helper reply, expire the interrupted candidate, and
  disable the account concurrently. Verify recovery retains owner/data identity,
  never restores a disabled account and never admits mismatched credentials.
  Exercise local model catalogue/chat/streaming/tool-call/embedding use through
  the real installed UI with LAN disabled. Check cross-owner model denials,
  disable/re-enable during a stream, slow consumers, host-service failure,
  stalled pipes and CLI loss; require helper listener expiry without a network
  fallback or disclosure of host credentials. Use only model/provider routes
  authorized for the acceptance run; transport fixtures make no inference claim.
  Open inline apps and terminal sessions for both owners in real browsers;
  verify separate app storage, concurrent mounts, ticket expiry/replay, logout
  during discovery/load/tool calls, sibling-app/owner attempts and CSP denial.
  Exercise a proved sidecar's real assets, cookies, uploads and bidirectional
  WebSocket traffic; retire the MCP lease during both stream types and require
  closure of both peers. Check cross-site/cross-app attempts, reserved paths,
  foreign redirects, worker restrictions, slow peers and connection/byte limits.
  Prove controller restart and fixed-port pipe failure cannot fall back to the
  application API, host networking or a shared sandbox origin.
  Disable during a running tool/stream and during controller/engine failure;
  require observed process exit without touching the other owner's jobs.
- Verify explicit team resource/dependency grants, edit conflicts, history and
  revocation of already running work. These features are still pending.
- Qualify local TLS/hostname provisioning, native protocols, bounded resource
  use, migration and backup/recovery. Cached online sessions and fixture-only
  endpoint tests cannot satisfy installed-candidate offline acceptance.
- In an owned Windows/Linux acceptance account, install and remove the exact
  public CA, verify real browser trust and cold localhost resolution, renew while
  streaming, interrupt certificate publication and simulate clock/expiry changes.
  Never change the user's ordinary trust stores or disable their active network
  adapters for a fixture run. Confirm no online DNS/ACME/issuer request occurs.

The runtime regression sources include policy drift, unconfirmed start/stop,
stale intent, wrong-owner protection and lost-create-response recovery using an
engine fixture. Native storage, setup, real HTTPS issuance/account dispatch and child-stdio/HTTP-parser regression
sources cover platform boundaries without claiming actual container/kernel isolation.
Regression and broader acceptance runs are reserved for release pre-flight under
the repository policy. Development checks are typecheck, lint and a non-container
application build. Controller authentication requires no model inference.
