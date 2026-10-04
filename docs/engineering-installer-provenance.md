# Installer release identity and provenance (#565)

The installer release now creates and verifies GitHub artifact attestations for
the original executable bytes before attaching them to a version release.
Building, signing and publication use separate jobs; ordinary PR builds inherit
the read-only workflow token.
Signing and publication run only for an official repository version tag.

The compiler job retains its immutable uploaded artifact ID and executable
SHA-256. For a release tag it also produces `installer-release-evidence.json`
and `installer-SHA256SUMS`. The inventory records the executable size/digest,
package version, exact source revision, tag and official workflow identity.
The helper refuses another checkout, version, workflow or ref and does not
export arbitrary environment variables.

The signing job downloads that artifact by ID, rechecks exact-source main
verification, and validates the downloaded bytes against the compiler job's
original digest. The pinned
[GitHub attest action](https://github.com/actions/attest)
creates SLSA build provenance for both the executable and source inventory.
The publisher downloads the same artifact, verifies both attestations with
`gh attestation verify`, and rechecks main verification immediately before
attaching the files. Verification requires the official repository and exact
workflow certificate identity including the version tag, GitHub Actions OIDC issuer,
exact source and signer digests, matching version tag and GitHub-hosted runner.
Neither later job rebuilds or replaces the executable.

## Verify downloaded release assets

Select the expected version, full source SHA and original executable SHA-256
from the reviewed release verification record. Retain the installer workflow's
run ID and compiler/digest evidence. Use the verifier from that trusted source
checkout, Node.js 22 or later, and an authenticated GitHub CLI with
[`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify) support.
[Download](https://cli.github.com/manual/gh_release_download) all three assets into a fresh directory:

```text
gh release download v<version> --repo mario-andreschak/FLUJO --dir <asset-directory> --pattern flujo-setup.exe --pattern installer-release-evidence.json --pattern installer-SHA256SUMS
node scripts/installer-release.mjs verify-download <asset-directory> <40-character-source-SHA> <version> <64-character-executable-SHA256>
```

The second command checks the executable, inventory and full checksums file
against those expected inputs, then requires both official hosted-workflow
attestations for that exact source and version tag. It requires no CI environment
variables and does not execute the installer. Any consistency or signature
failure returns a nonzero exit code. Retain stdout/stderr, the exit code and the
three downloaded files' hashes with the release verification record. Missing
assets or attestations leave release acceptance incomplete.

These GitHub attestations establish the bootstrapper's byte/source provenance.
Windows Authenticode signing and its certificate/rotation decision are recorded
separately in the [Windows release checklist](windows-installer-release-checklist.md).
Complete that checklist's installed Windows scenarios after provenance verification.

The checksums file is a deterministic inventory of those two signed subjects.
The executable, inventory and checksums are retained as release assets. The
bootstrapper's provenance scope covers those bytes; downloaded app/package
dependencies and installed-consumer behavior remain separate acceptance work.

The local fixtures use synthetic, unexecuted bytes. They check altered/missing
files, source/version/digest mismatches, rejected signatures and mandatory
workflow ordering/permissions. They do not constitute a real signed release.
Acceptance still requires a successful protected main merge, exact main-push
verification, an actual version-tag run and independent verification of the
downloaded release assets, followed by the installed-distribution checks.
