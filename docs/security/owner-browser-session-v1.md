# Owner browser sessions

This adds server-issued browser sessions to the existing owner policy. It does
not replace scoped API bearers or the separate worker and private voice credentials.

Select the existing absolute `FLUJO_OWNER_AUTH_FILE` and set
`FLUJO_OWNER_BROWSER_ORIGIN` to the exact browser origin, such as
`http://localhost:4200`. Plain HTTP is accepted only for literal loopback hosts;
other origins require HTTPS. The configuration must contain the origin alone,
without a path, credentials, query or fragment. Request Host, URL and browser
Origin must agree with it; forwarded headers cannot establish browser authority.

At `/owner/login`, an existing owner bearer with `control:admin` and
`secrets:read` can create a new browser session. The form clears the credential
after the request and never stores it in localStorage, a URL or a session record.
Execution-only credentials cannot mint administrative sessions. A cookie alone
cannot log in, select a caller-chosen session ID or rotate itself.

The cookie is host-only, Path `/`, HttpOnly and SameSite Strict. HTTPS uses the
Secure `__Host-flujo-owner` cookie; HTTP loopback uses `flujo-owner-local`.
Only a random 32-byte server-issued identifier appears in the cookie. Its SHA-256
digest names a bounded record in `<owner-policy-file>.sessions`, outside the
workspace when the owner policy follows its documented placement contract.
Records contain owner, source credential, policy revision, origin and timestamps;
neither the original bearer nor plaintext cookie is persisted. New directories
and records use POSIX 0700/0600. Windows still requires the operator-controlled
policy directory's owner-only ACL; this feature does not establish an OS keystore.

Sessions last at most eight hours and never outlive the source credential.
Each request independently reads durable policy and session state, so sessions
survive application restart without relying on shared proxy/handler memory.
Credential revocation, removal, policy replacement, expiry and browser-origin
changes invalidate sessions. An authorization witness additionally rechecks the
session before effects; logout invalidates existing witnesses as well as later
requests. Corrupt or unsafe storage fails closed with generic diagnostics.

Cookie-authenticated mutations require an exact Origin. GET/HEAD also require
that Origin, or the browser's same-origin Fetch Metadata when Origin is absent.
An explicit invalid bearer never falls back to a cookie. Private voice admission
continues to require its existing bearer and workspace-bound capability.

`POST /api/owner/session` exchanges an authenticated administrative bearer.
`GET` returns authenticated owner/expiry information without credentials.
`DELETE` clears the cookie and removes its durable record. Only this exact DELETE
is permitted to clear an expired cookie without active authentication; it remains
guarded by the configured Host/URL/Origin and existing worker/exposure boundary.

Node startup refuses Network/Public exposure without a readable private policy
containing an active credential. Explicitly broken owner configuration also
refuses localhost startup. The diagnostic gives a loopback recovery path without
printing policy paths, credentials or parse failures. Worker startup instead
requires its dedicated bearer, independently of the general owner policy.
The guard runs before workspace initialization. The proxy independently refuses
nonlocal exposure with no owner policy, including protocol/OpenAI routes.
In a source Next 16.3.8 dev probe, Next briefly printed Ready while compiling
instrumentation, then exited 1 at this guard; this is not a claim that no TCP
listener briefly existed or that an installed package passed acceptance.

The shared workspace route wrapper retains the original owner authorization for
SSE responses. It rechecks before and after reading each chunk and every second
while idle or backpressured. Revocation discards queued output, errors the response
with a generic diagnostic, and cancels the producer through its existing cleanup
contract. Request abort, consumer cancellation and normal completion release the
watcher. Reconnection requires fresh admission. Trusted execution extensions and
worker/protocol exceptions retain their own authority and cleanup contracts.
This does not prove cancellation of effects in a producer that ignores cancellation,
or cover transports that do not use this wrapper.

This implements browser login/session/logout, request-time revocation and owner
SSE revocation at the shared workspace boundary. The first-owner one-time
pairing/bootstrap workflow, remaining transport and sensitive service boundaries, consumer migration,
private legacy credential migration and complete OS isolation acceptance remain
part of #566–#568. Source tests do not establish current installed-artifact,
human or independent external acceptance, and do not award the A- outcome.

The sign-in page renders outside workspace/bootstrap providers, so an
unauthenticated request can reach the form before protected workspace APIs run.
Other pages keep their existing bootstrap. Focused node boundary tests and
jsdom login/bootstrap tests are separate from a real browser or packaged runtime
acceptance run; their exact results belong to the PR validation record.
