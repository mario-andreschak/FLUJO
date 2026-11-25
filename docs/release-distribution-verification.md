# npm distribution evidence (#565)

The release candidate consists of the original five tested tarballs and their
existing revision/version/integrity manifest. Preparation additionally records:

| File | Meaning |
| --- | --- |
| `release-evidence.json` | Exact source/version, SHA-256 and SHA-512 identities and sizes for all tarballs, source-lock digest, SBOM digest, Node/npm/platform and whitelisted workflow/run identity |
| `source-lock.sbom.cdx.json` | npm-generated CycloneDX source-lock dependency inventory, including development/build dependencies; source revision and inventory scope are explicit |
| `SHA256SUMS` | Full expected tarball/manifest/evidence/SBOM inventory; no stale, missing or extra checksum entries accepted |

The source-lock SBOM is generated offline without lifecycle scripts. npm may
display the checkout folder as the root component name; its canonical Package
URL identifies `flujo-ai@<version>`. This inventory does not describe dependency
versions later resolved by a clean consumer, host-installed MCP packages,
container OS packages or the Windows installer's downloaded prerequisites.
Installed-artifact evidence must retain its own resolved dependency graph and
identity. Checksums establish consistency; signatures establish provenance.

The new `attest` job receives the exact successful prepare job's artifact ID,
waits for exact-source main verification, validates all bytes/source metadata,
and creates hosted GitHub provenance and source-lock SBOM attestations. Signing
permissions are confined to that job; no build or candidate lifecycle script
runs with its signing identity. Ordinary checkout credentials are not persisted.

Publication and finalization verify provenance signatures for **all five
tarballs plus manifest, release evidence and SBOM**, requiring the official
`publish-npm.yml`, main ref, expected source SHA, matching workflow SHA and
GitHub-hosted runners. Any failed signature stops the phase. Existing tested
tarball SHA-512 registry readback, exact-main checks, immutable version handling,
tag matching and original-run retries remain in force. npm trusted publishing
[automatically generates npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
without introducing a long-lived write token.

## Where each release's SBOM lives

Every release has a dependency list (SBOM) and a signature for each download:

| Download | SBOM | Signature (provenance) |
| --- | --- | --- |
| npm packages | `source-lock.sbom.cdx.json`, attached to the GitHub release and attested for every tarball | `release-evidence.json` and `SHA256SUMS`, attached to the GitHub release; every tarball attested |
| Docker image | OS and installed-package SBOM attested on the exact image digest (`--predicate-type https://cyclonedx.org/bom`) | Provenance attested on the exact image digest |
| Windows installer | The installer downloads the npm application above, so the release's `source-lock.sbom.cdx.json` lists what it installs | `installer-release-evidence.json` and `installer-SHA256SUMS`, attached to the GitHub release and attested |

The npm finalization step attaches the three npm inventory files to the GitHub
release after the installer and image workflows succeed. Releases published
before this change keep their SBOM only in the attestation store and the
30-day workflow artifact.

## Consumer verification

Use the public source at the expected release SHA and retain the official
release run ID, workflow path/ref and head SHA. Download the inventory from the
release page (`gh release download v<version> --repo mario-andreschak/FLUJO
--pattern source-lock.sbom.cdx.json --pattern release-evidence.json --pattern
SHA256SUMS`), or that run's named `npm-release-<version>-<SHA>` artifact. The
tarballs come from the npm registry. Merely receiving files proves no identity.

Run the consistency check from that trusted source checkout:

```text
node scripts/release-evidence.mjs validate <artifact-directory> <40-character-SHA> <version> <source-checkout>
```

Then verify each tarball, `manifest.json`, `release-evidence.json` and
`source-lock.sbom.cdx.json`:

```text
gh attestation verify <file> --repo mario-andreschak/FLUJO --predicate-type https://slsa.dev/provenance/v1 --signer-workflow mario-andreschak/FLUJO/.github/workflows/publish-npm.yml --source-digest <SHA> --signer-digest <SHA> --source-ref refs/heads/main --deny-self-hosted-runners
```

For the tarballs' SBOM predicates, run the same command with
`--predicate-type https://cyclonedx.org/bom` instead. Retain verification stdout/stderr,
exit codes and all artifact SHA-256 values. Compare each npm registry version's
`dist.integrity` with the tested manifest; verify the downloaded registry bytes,
not just a package page's version label. Inspect the npm provenance's source
identity and registry signatures separately. Never accept a successful local
checksum check as signature verification.

## Remaining distribution acceptance

The metadata/tamper tests use synthetic tarballs and stub signing verification;
they do not prove an actual signed release or installed behavior. A real release
must demonstrate hosted attestation generation/verification, registry bytes,
Windows/Linux packed process smoke and installed browser/operator journeys.

Container digest/OS SBOM and installer EXE/bootstrap provenance remain separate
distribution slices. Image acceptance must refer to the exact tested/published
digest; a rebuilt image with the same source tag is a different artifact.
Installer checksums and signatures must retain the bootstrap source/version,
compiler identity and downloaded prerequisite identities. Source/test success
does not erase pending scanner findings or independent/human acceptance gates.
