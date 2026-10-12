# Strict owner principal seam for private remote voice

This source layer stacks on #582 at `2c02fd0d3e4c36e702537a2e67bdd3d240101533`.
It advances #566 and supports the additive remote voice integration on #560,
without implementing a browser session or replacing local voice admission.

## Exported boundary

`resolveOwnerRequest(request, scopes?, options?)` in
`src/backend/services/security/ownerAccess.ts` is the strict handler boundary.
It reads the configured private policy before body parsing or storage selection.
Missing configuration is a 503, invalid/missing bearer is a 401, and insufficient
scope or missing required workspace is a 403. Responses contain fixed messages
and `no-store`. Protocol callback exemptions and anonymous localhost compatibility
do not apply to this resolver.

Successful resolution returns `{ ok: true, authorization }`. The frozen
`authorization.principal` contains `ownerId`, `credentialId`, frozen `scopes`,
optional `workspaceId`, `expiresAt`, and `policyRevision`. Identity and workspace
come exclusively from the validated policy record. Query, cookie, forwarded,
client-correlation and claimed owner/workspace headers cannot set them. Principal
metadata is evidence/correlation, not a transferable authentication token.

`authorization.recheck()` re-reads durable policy and returns either null or a
fixed denial Response. The callback captures the credential digest and authenticated
principal, not the bearer token. Expiry, revocation, credential removal/rotation,
owner/workspace changes, any new policy revision, invalid policy, or configured
path change ends the witness. Any semantic policy revision conservatively ends
existing witnesses, even if it changes another credential. A fresh authenticated
request is needed; there is no implicit policy refresh during a stream.

The consuming route must call recheck before each effect and during streams,
cancel owned work on denial, and prevent late results/receipts from continuing a
revoked turn. This module does not schedule polling or implement the consumer's
stream lifetime. It does not accept a client-supplied principal to re-authorize.

## Voice-only workspace grant

The new `avatar:voice` scope is classified only for POST on the following exact
remote actions from #560's voice handler:

```text
/api/avatar/remote/native-turn
/api/avatar/remote/native-input
/api/avatar/remote/native-observe
/api/avatar/remote/native-played
/api/avatar/remote/native-reset
/api/avatar/remote/native-result
/api/avatar/remote/native-result-receipt
```

Unknown actions, nested/suffixed paths, other methods, and ordinary local avatar
routes retain conservative classification. The exact
`GET /api/avatar/remote/availability` also uses `avatar:voice`; other availability
methods/paths retain conservative scopes. A voice request always requires an
explicit workspace, even if a caller supplies `requireWorkspace: false`.
Workspace IDs use the existing identifier grammar and reject Windows device names.
Workspace-bound credentials are limited to voice-only scopes, preventing them from
being mistaken for generic authorization for legacy control/secret APIs.

Trusted issuance can use
`issueOwnerCredential(['avatar:voice'], expiresAt, now, { workspaceId })`.
The raw random credential is returned once; only its digest is persisted. Issuance
remains a trusted operator operation; this layer exposes no public enrollment API.
Older binaries reject the new scope/field rather than silently opening access.
Legacy credentials remain parse-compatible. Workspace existence and allowed Origin
must be checked by the consumer before selecting its workspace. Workspace deletion
or rename alone is not represented by the policy revision, so consumers must also
repeat their workspace lifetime checks.

The exported `isRemoteAvatarVoiceRequest` identifies only these classified
paths/methods. `assertRemoteAvatarVoiceOrigin` requires an exact Origin matching
canonical HTTP(S) `FLUJO_AVATAR_REMOTE_ORIGIN` (no path, credentials, query, or
fragment). Missing/invalid configuration is 503; mismatched/missing Origin is 403.
Nonworker proxy ingress admits this different-origin BFF only after the selected
Host boundary and strict workspace-bound voice authentication. The handler must
repeat Origin and principal admission. Worker proxy ingress is unchanged and
requires its dedicated snapshot/worker bearer; a consumer can compose a separate
private voice capability but must authenticate both before body/storage/effects.
Origin itself is never identity, and no browser credential/public CORS mechanism
is added by this layer.

Worker/snapshot/provider credentials remain separate. This witness does not grant
Root, account, lease, budget, startup, capture, or COMMIT authority and does not
establish a private keystore. Provider keys must remain in the BFF's private
registration rather than being returned to browser clients.

## Source evidence and remaining gates

On 2026-10-03, the owned Windows checkout with Node 22.13.1, Next 16.3.5,
TypeScript 6.0.3 and Zod 4.4.3 initially passed 64 focused tests across
`ownerPrincipal.test.ts` (28) and `ownerAccess.test.ts` (36). A subsequent exact
availability route/method test brings the principal suite to 29 cases. The existing suite
was extended with two private BFF proxy/Origin tests; the final combined run passed
all 67 cases (29 principal, 38 owner/proxy).
includes three tiny serial OS subprocess checks of valid/revoked/corrupt policy.
New tests cover immutable trusted identity, hostile request claims, narrow scope,
workspace requirements, exact route/method classification, revocation/rotation,
expiry boundaries, conservative revision changes, corruption and configuration
switch. The new module/test scoped TypeScript check, changed-file ESLint and diff
check passed.

```powershell
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/security/ownerPrincipal.test.ts __tests__/security/ownerAccess.test.ts
node node_modules/typescript/bin/tsc --noEmit -p .tmp/principal-tsconfig.json
```

The ignored Jest override corrects the managed-Windows discovery issue documented
in #582; no shared runner or dependency files were changed. The scoped TypeScript
configuration includes the two owner modules and new test with explicit Node/Jest
types and no incremental output. The earlier root typecheck at #582 is not a pass
for this new revision. Repository typecheck/build, remote voice consumer streaming
and cancellation tests, browser pairing/session lifecycle, installed-artifact
acceptance, live provider/deployment observations, human acceptance, and independent
reassessment remain pending. #566 and the A- gate remain open.
