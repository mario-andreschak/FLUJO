# Private avatar voice ingress

This additive consumer combines Avatar #560 and the owner principal seam #596.
Foundations are Avatar `3d85f2df3070d1b92aea68732cdeda028d30e6ac`, Security
`5e99e744` and portable avatar `e1e26fba309a011fd5e28a24b82304c6d7c3997b`.
All 18 generated portable files are recorded in `src/vendor/avatar/PROVENANCE.json`.
The ordinary `/api/avatar/native-*` routes keep strict loopback admission.
The new ingress selects only an existing workspace granted by the private owner
policy. It grants no task, provider-account, original O ledger or migration authority.

## Server registration and HTTP boundary

Configure `FLUJO_OWNER_AUTH_FILE` with a private policy containing a voice-only
`avatar:voice` credential with an explicit workspace and expiry. Configure
`FLUJO_AVATAR_REMOTE_ORIGIN` to the exact HTTPS origin of the private BFF.
HTTP is accepted only for literal loopback qualification. Credentials, policy
files, session keys and provider keys stay outside Git, browser code and URLs.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/api/avatar/remote/availability` | Authenticated availability JSON |
| POST | `/api/avatar/remote/native-turn` | Existing setup voice request; NDJSON |
| POST | `/api/avatar/remote/native-input` | Complete WAV recording; recognized text |
| POST | `/api/avatar/remote/native-observe` | Existing single-use turn observation |
| POST | `/api/avatar/remote/native-result-receipt` | Canonical conversation/message IDs, locale and optional expected digest; receipt ID |
| POST | `/api/avatar/remote/native-result` | Receipt ID, avatar and locale; NDJSON |
| POST | `/api/avatar/remote/native-played` | Exact turn/sample playback acknowledgement |
| POST | `/api/avatar/remote/native-reset` | Exactly `{}`; clears owned voice history/receipts |

Outside worker mode, `Authorization` carries the private voice credential.
In worker mode, `Authorization` retains the separate snapshot/control bearer,
and `x-flujo-avatar-authorization` carries the voice bearer. Both are checked
before any workspace read. The ordinary workspace wrapper repeats its existing
transport check; worker readiness and assigned workspace remain mandatory.
All requests require the exact approved `Origin` and `x-flujo-avatar-client`
UUID. A supplied workspace query/header must agree with the policy grant.
Storage selection uses the trusted grant, never an identity claimed by the caller.

The JSON request body is bounded to 12 MiB before and during reading. WAV
validation retains the existing mono 16-bit PCM, 8–48 kHz and 30.1-second limits.
Audio output uses `application/x-ndjson`, with start/audio/caption/complete or
terminal error events, cumulative captions and exact playback sample counts.
The existing 24 kHz output assumption is unchanged and is not a measured provider
qualification. Speech remains the original OpenRouter configuration; this change
does not establish Modal speech or Modal-backed work inference.

## Browser-facing BFF requirements

The BFF authenticates its HttpOnly SameSite session and checks Origin and CSRF.
It owns fixed upstream origin/workspace and private capability registration.
Strip caller authorization, forwarding, workspace and voice-client headers;
set the upstream headers from that registration and a server-assigned UUID per
browser session. Never give either bearer to browser JavaScript or EventSource.
The public session envelope may contain an opaque scope key, workspace/namespace,
voice availability and a browser-safe CSRF token. Change its scope on login,
logout, expiry, workspace reassignment or registration revision.

Forward bounded uploads and streamed output with backpressure. Propagate browser
disconnect/abort to the upstream request. Do not buffer the whole audio response
or retry a voice/work POST after an uncertain outcome. On session loss, abort all
live transports, reset the old internal voice UUID and never reuse that UUID,
including when reset delivery is uncertain. A distinct voice grant per browser
session gives independent durable revocation; a shared grant requires this BFF
session/UUID boundary and does not itself identify different browser sessions.

## Lifetime, receipts and limits

Trusted scope contains owner/credential/workspace/policy revision and the worker
mode/token revision where applicable. It retains no raw bearer. Durable owner
policy, approved origin, worker token/readiness and workspace existence are
rechecked at asynchronous effect boundaries and every 250 ms. Slow workspace
validation cannot delay the synchronous revocation check. Revocation aborts body
reads, recognition, provider reads and blocked output, and clears session receipts.
Observed revoked scopes remain tombstoned until grant expiry. Origin/worker
changes require a fresh authenticated witness; old streams are never refreshed.
There are at most 128 live/tombstoned grant scopes and 128 voice client sessions;
capacity exhaustion fails closed. State is process-local. Use one backend instance
or explicit affinity; a restart drops voice receipts and requires reconnection.

Narration resolves the canonical root public reply with existing execution access
checks. A receipt binds conversation/message IDs and a reply/status digest, lasts
two minutes and is single-use. Currency and authority are checked before receipt
consumption, before provider entry and while publishing audio/qualification.
Changing the latest reply, editing its content or revoking access stops narration.
No browser-supplied success claim or tool content becomes a narration result.

Receipt requests may additionally supply `expectedResultDigest`, exactly 64
lowercase hexadecimal characters. It is SHA-256 over the UTF-8 bytes of
`JSON.stringify({reply,mode:'flujo',status})` in that property order, using the
canonical resolver's exact stripped, trimmed and 8000 UTF-16-unit bounded reply
and status. This is not a stable-key JSON digest or a hash of the unprojected
assistant message. A mismatch returns 409 before any receipt is offered. The
existing receipt then retains that matching digest and rechecks canonical
currency before provider entry and during output. Requests omitting this field
retain their existing local and authenticated behavior.

The digest is a caller's currency constraint, not proof of reviewer acceptance.
O must derive it from its trusted successful developer observation, bind the
exact worker/workspace/conversation/message to a matching accepted review, and
gate both issuance and use on its live session and accepted-task record. Browser
output, O task IDs and caller-selected digests cannot establish that binding.
This extension alone neither implements O's accepted-task gate nor enables its
disabled result narration. Older servers reject the new field; callers must not
retry issuance with the field removed after a refused or uncertain request.

## Evidence and deployment gates

Backend tests use provider fixtures. The independent ingress suite uses genuine
loopback HTTP and synthetic private policy files; workspace storage/startup are
substituted explicitly. It covers first-byte streaming, disconnect, revocation,
expiry, configuration changes, slow workspace validation, worker token rotation,
retirement and partial uploads. These are transport fixtures, not a deployed Next
server, genuine provider calls, microphone acceptance or Modal swarm qualification.

The own-lockfile Windows checkout passed `npm run typecheck` (Next route type
generation and full repository TypeScript) before the final host render cases
and receipt refresh fix. The final scoped TypeScript check covers both routes,
backend, host and all changed tests with the project's Next/CSS/Jest ambient
types. The checkout also passes 128 focused Node/Jest checks
(29 voice backend, 31 remote ingress, 67 owner/principal and one workspace route
coverage), eight mounted hook cases and three AvatarWorld host render cases.
The host substitutes scene, work and audio. It checks transport injection, scope
changes, original local availability and receipt preservation when the same
canonical reply is refreshed. The hook substitutes microphone/audio
hardware; these are not eight physical-device or provider trials. Scoped ESLint
and whitespace checks pass. Initial cancellation, pending-workspace revocation
and transcription-denial failures were corrected before the final checks.

The first Windows sync matched all 18 working files but only one staged Git
member: 17 provenance hashes described CRLF files while Git shipped LF. The
portable owner corrected sync to write and hash canonical UTF-8 LF at the pin
above. Final packaging matched all 18 actual staged Git blobs, all 18 working
files and all 18 Git blobs from the exact portable source pin. No local
line-ending match alone qualifies the shipped artifact.
Consumer `.gitattributes` keeps only the generated avatar tree and capture
worklet at LF on checkout, preserving those hashes across Windows extraction.

Installed image/source provenance, the private BFF integration, live phone audio,
actual admitted provider inference, canonical task/reviewer results, OFF and
cloud restart/PC-off recovery must still be verified on the combined deployment.
The original O providers, allowance, OFF, unknown operations and cleanup records
remain separate and unchanged.
