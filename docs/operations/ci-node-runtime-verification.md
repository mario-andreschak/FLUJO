# CI runtime identity and qualification

The canonical application/MCP policy is exported by `bin/node-runtime.mjs`:
`^22.17.0 || ^24.2.0`. Its six engine declarations, independent MCP embedding,
entry refusal and installer migration belong to the paired runtime source
change. CI consumes that policy rather than implementing another eligibility
rule. Production successor `1486796b411351a3ade9291b85d195df6b7b41ad`
adds the early Unix refusal before bootstrap and log writes; the earlier
`7f3cfe988213ad76fa7990592a98e70629500308` alone is not the accepted pair.

| Profile | Exact Node | libuv | Required purpose |
| --- | --- | --- | --- |
| Historical | 22.13.1 | 1.49.2 | Original ordinary default-heap build only |
| Minimum 22 | 22.17.0 | 1.51.0 | Build, workspace types and actual packed-process checks |
| Current 22 | 22.23.3 | 1.51.0 | Build, workspace types and actual packed-process checks |
| Minimum 24 | 24.2.0 | 1.51.0 | Build, workspace types and actual packed-process checks |
| Current 24 | 24.21.0 | 1.52.1 | Build, workspace types and actual packed-process checks |

Broad qualification runs locally before publication. The automatic
`verify.yml` workflow has one `verification` job: exact Node 24.21.0, one
ordinary default-heap application build, MCP typechecks and payload validation,
workflow/release contracts, and the focused critical regression list.

The manually dispatched `verify-full.yml` retains Ubuntu and Windows coverage
of all four supported profiles, actual packed-process checks and the broader
test/scanner suites. Each profile verifies the binary before dependency and
build commands. Bash failure propagation prevents a later successful command
from hiding an earlier failure on Windows. Do not dispatch this matrix simply
to repeat an already qualified PR. Historical build scope cannot admit Node
22.13.1 to installed application, MCP or container acceptance.

The source ruleset requests the single `verification` context. Repository
administrators must keep the live ruleset aligned with it; workflow changes
cannot remove obsolete required contexts from GitHub's live configuration.

Other CI workflows use exact current Node 22.23.3; npm publication uses exact
24.21.0 and retains its separately pinned npm toolchain. Each direct setup is
immediately followed by a mandatory binary check. Workflow contracts refuse
moving versions, early Node commands, missing/optional guards, omitted edge
profiles, heap overrides and missing runtime artifact retention. New stacked
release jobs also have to satisfy this contract: when the frozen installer
provenance stack is integrated, both its attest and publish jobs must receive
the same current 22.23.3 pin and immediate binary check.

## GitHub action runtimes

Action runtimes are separate from the application Node version selected by
`setup-node`. Workflows pin the official Node 24 actions to immutable commits:
checkout 7.0.1, setup-node 7.1.0, upload-artifact 7.0.2 and download-artifact
8.0.2. These require Actions Runner 2.327.1 or newer; the workflows use
GitHub-hosted runners. Application Node pins and executable measurements remain
in place after the action upgrades.

[Checkout 7](https://github.com/actions/checkout/releases/tag/v7.0.1) refuses
unsafe fork checkout in privileged `pull_request_target` and `workflow_run`
contexts by default. These workflows do not opt out of that protection.
[Setup-node 7](https://github.com/actions/setup-node/blob/v7.1.0/README.md)
removes the dummy `NODE_AUTH_TOKEN` fallback; the npm release workflow uses
trusted publishing and explicitly disables automatic package-manager caching.
Explicit npm cache inputs on verification jobs are retained.

[Upload-artifact 7](https://github.com/actions/upload-artifact/releases/tag/v7.0.0)
keeps zipped archives as its default; no workflow opts into direct unzipped
uploads. [Download-artifact 8](https://github.com/actions/download-artifact/releases/tag/v8.0.0)
fails on artifact digest mismatch by default. Release handoffs retain that
default and their existing exact artifact IDs and package checksum checks.

## Official executable evidence

The [retained packet](../audits/scorecard-563/evidence/official-node-integrity-2026-10-04/verified-node-binary-receipt.json)
records five real GnuPG signature verifications, all exit 0, against the official
[Node release keys](https://github.com/nodejs/release-keys) at immutable commit
`481637f813e912c4aa3622d7964ab426c97b8e8d`. Verification used an isolated
public keyring, disabled automatic key retrieval and retained raw signature
status, stderr, signatures and checksum files without newline conversion.
No global/private keyring was imported or changed.

The unchanged upstream README's relative links resolve to the 29 retained
[public key files](../audits/scorecard-563/evidence/official-node-integrity-2026-10-04/keys/).
Their [copy receipt](../audits/scorecard-563/evidence/official-node-integrity-2026-10-04/public-key-document-targets.json)
binds downloaded bytes to the same immutable upstream commit and Git blobs.
Restoring these document targets does not add signature or issuer verification.

Each downloaded Linux x64 tar archive first matched its signed checksum. The
fixed `node-vVERSION-linux-x64/bin/node` member was then streamed into SHA-256
without extracting a directory or executing downloaded binaries. Windows x64
executable hashes come directly from the signed `win-x64/node.exe` entries.
The archives remain in the source observer's retained local evidence directory;
the portable packet retains their URLs, sizes, hashes and member derivation.
The initial xz extraction failed because the native tar could not start an xz
filter; final verification uses the separately signed gzip distributions.

The actual one-byte checksum mutation control produced GnuPG `BADSIG`/exit 1
with the original signature and keyring. Its [raw receipt](../audits/scorecard-563/evidence/official-node-integrity-2026-10-04/controls/receipt.json)
and inputs are retained. Source tests also refuse one-byte executable mutation,
wrong Node/libuv/platform/architecture and absent binary hashes.

`scripts/verify-ci-node.mjs` measures the actual executable and libuv against
`scripts/ci-node-binaries.json` before dependency/build/publication commands.
It records exact Node, libuv, platform, architecture, OS release, executable hash,
Git head, dirty state and verifier/manifest/canonical guard hashes. Production
jobs retain the runtime records even on failure. Self-measurement identifies the
selected binary; it does not establish an independently trusted boot environment.

## Containers and qualification boundary

Both Docker stages use the observed current 22.23.3 bookworm-slim base at
`sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`.
The public Docker Hub metadata is retained and hashed. Each stage independently
checks its contained Node executable against the signed official distribution;
the runtime copies the canonical `bin/` guard required by its launcher. The
existing image build heap configuration remains a separate container profile.

Container measurement has no Git checkout, so its source SHA stays null and
explicitly unqualified. Image evidence and immutable same-digest inspection
must bind source/version/capability labels separately before signing or aliases
advance. Registry metadata alone does not authenticate the Debian package set;
the tested image inventory and release attestation remain required.

These are frozen source requirements and authentic binary evidence. The old
hosted Windows descriptor/pathname comparison remains a deliberately failed
diagnostic, with no installed acceptance implied. Fresh qualification of the
exact integrated candidate, actual npm/image/installer release journeys,
positive/stale review controls, human drills and independent A- acceptance
remain pending. No version bump or rebuild of frozen integration 73 occurs here.
