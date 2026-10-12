# Registry GitHub sign-in acceptance — issue 224

The existing registry OAuth implementation passed its remaining live acceptance on 2026-10-12. This record closes the deferred acceptance in [issue #224](https://github.com/mario-andreschak/FLUJO/issues/224); it introduces no application feature or application code change.

## Tested deployment

FLUJO 3.46.3 was tested at `d3e5c64ec52f08de16c221140d99d7ea788d80c5`, application source tree `7272bc39bb7123e5fef7bbce8f21ecd9505ccb1e`, with Node 22.23.3 and Next 16.4.0. The ordinary application and five bundled MCP builds passed; production build ID is `dKOX9ytD2yyrWSQ-090Jl`. The client used an isolated local workspace and private operator encryption mount. The active user installation was preserved.

The existing live hosted registry at `https://registry.flujo.com.co` was used for sign-in acceptance without publishing, deleting or editing any package. Read-only deployed metadata verified registry 0.1.0, Node 24.18.0, Fly machine `2870740b7d7678` and image `sha256:2db54857b703cd224df3be8b60f0d5fcec70cb443f4a10fa01c32475f51c37a9`. The inspected registry checkout was `33192a12f29eab48b602f401f2222a62d8129567`; source equivalence to that image is not inferred. Provider configuration and existing account credentials were preserved.

## Completed criteria

- The adapter implements the existing authorize and exchange contract with no remaining TODO: registry authorize receives the callback, opaque state and S256 challenge; token exchange uses the stored verifier and issuing registry.
- A fresh sign-in initiated by the real FLUJO account panel completed entirely in the browser through GitHub, Supabase and the deployed registry. GitHub used the existing `mario-andreschak` account with only `user:email`. FLUJO received its real callback and returned to Packages with success in the initiating workspace. The account displayed signed-in, confirmed publisher status on desktop 1280×720 and phone 390×844. Reload preserved the signed-in account and cleared the one-time success banner.
- The actual stored account file contained encrypted access and refresh tokens, no raw JWT, `authMethod: oauth` and the GitHub link. The live account API decrypted the stored credential successfully and exposed `********`, without access/refresh token fields or ciphertext. Email addresses, credential values and screenshots remain private; the receipt contains boolean checks and a ciphertext-file hash.
- A hostile-Origin initiate request returned 403. A callback suffix also returned 403. The exact callback path accepted the provider Origin and rejected invalid state with its error redirect. Temporarily withholding only the owned operator secret produced 423 on initiation and on a callback with an unexpired, server-issued state. Restoring the mount restored availability. These checks retain the local, exact-path and workspace/PKCE boundaries.

The accepted browser attempt was the second attempt. The first stopped at an in-app browser `ERR_BLOCKED_BY_CLIENT / inspector` refusal; its older callback returned 500 during a separate HTTPS diagnostic. Those observations remain recorded as unsuccessful, with cause unestablished. Fresh authorization then completed the whole browser roundtrip automatically; no manual callback hop was used in the accepted result. The browser engine version was unavailable through supported inspection APIs.

## Local qualification

Pinned dependency installation passed in 359.334 seconds, source/test typecheck in 97.722 seconds, source lint in 195.457 seconds, and the non-container application/MCP build in 542.263 seconds. Five route/UI/security suites passed 55 tests in 30.936 seconds; four registry service/client/destination/workspace suites passed 61 tests in 5.135 seconds. Measurements are separate because some work overlapped. Independent read-only review found no actionable defect in the selected implementation and confirmed the narrow acceptance coverage.

The [sanitized receipt](evidence/registry-oauth-224-2026-10-12/receipt.json) binds the exact source, build, runtime, inputs and completed controls. This documentation-only commit retains the tested application, dependency and configuration inputs, so those results remain valid. No full suite, remote CI dispatch, image build, installed-package release check, paid model call or release was performed. Existing security requirements, paused verification workflows and release acceptance definitions remain unchanged.
