# Installer release identity and provenance (#565)

The installer release now signs and verifies the original executable bytes
before attaching them to a version release. Building, signing and publication
use separate jobs; ordinary PR builds inherit the read-only workflow token.
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
attaching the files. Verification requires the official repository/workflow,
exact source and signer digests, matching version tag and GitHub-hosted runner.
Neither later job rebuilds or replaces the executable.

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
