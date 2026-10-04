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

The existing Ubuntu and Windows production jobs each execute all four supported
profiles serially. Every profile verifies the binary before `npm ci`, uses
`npm run build` with the ordinary default heap, then enforces MCP typecheck,
payload validation and `npm run smoke:mcp-artifacts`. Bash failure propagation
prevents a later successful command from hiding an earlier failure on Windows.
The unchanged 13 required check names and exact main-push publication gate
remain the acceptance contract. Historical build scope cannot admit Node
22.13.1 to installed application, MCP or container acceptance.

Other CI workflows use exact current Node 22.23.3; npm publication uses exact
24.21.0 and retains its separately pinned npm toolchain. Each direct setup is
immediately followed by a mandatory binary check. Workflow contracts refuse
moving versions, early Node commands, missing/optional guards, omitted edge
profiles, heap overrides and missing runtime artifact retention. New stacked
release jobs also have to satisfy this contract: when the frozen installer
provenance stack is integrated, both its attest and publish jobs must receive
the same current 22.23.3 pin and immediate binary check. Their older moving
`22` selectors intentionally fail this contract until that integration is fixed.

## Official executable evidence

The [retained packet](../audits/scorecard-563/evidence/official-node-integrity-2026-10-04/verified-node-binary-receipt.json)
records five real GnuPG signature verifications, all exit 0, against the official
[Node release keys](https://github.com/nodejs/release-keys) at immutable commit
`481637f813e912c4aa3622d7964ab426c97b8e8d`. Verification used an isolated
public keyring, disabled automatic key retrieval and retained raw signature
status, stderr, signatures and checksum files without newline conversion.
No global/private keyring was imported or changed.

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
