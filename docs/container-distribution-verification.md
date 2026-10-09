# Tested container publication (#565)

The official image workflow retains one Linux/amd64 image configuration ID. It
tests that ID through the running MCP proxy, generates a pinned Syft CycloneDX
inventory from its Docker filesystem, then pushes the same ID to the full source
revision tag. Registry readback by manifest digest must resolve to that tested
configuration ID. There is no second build for publication.

Retries pull a previously signed full-revision candidate, verify its official
exact-source provenance, validate compatibility labels, and test that image
again. An unsigned partial candidate cannot be certified merely from labels;
resume its original successful candidate job's failed attestation/publication
jobs. Authentication and transport
failures cannot be interpreted as a missing image. An existing revision image
with different bytes is refused. The registry must return a single-platform
manifest; a multi-platform index is not accepted as this tested artifact.

The retained `image-evidence.json` identifies source/version, tested config ID,
registry manifest digest, platform/user, compatibility labels, source-lock hash,
SBOM hash and whitelisted workflow/run identity. `image.sbom.cdx.json` inventories
OS and installed application packages, including Debian and npm components. It
excludes packages installed later for optional MCP servers. Inventory generation
does not establish that those components have no vulnerabilities.

Both image inspection and retained JSON validation require every compatibility
label, including the exact string `io.flujo.worker.snapshot-source="1"`. Missing,
wrong or numeric capability markers refuse before evidence can be signed. The
promotion readback repeats these checks on the immutable same-digest image before
any version, short-source or latest alias advances. A same-version legacy image
cannot acquire this capability through a configuration override.

A separate job receives the original evidence artifact ID, rechecks main CI and
source/metadata identity, and signs registry provenance, the container SBOM and
both retained JSON files. Build and application lifecycle commands have no
attestation authority. The promotion job requires all four signature checks
against the official main workflow/source SHA and hosted runner identity, pulls
the signed digest, then checks every immutable alias before writing channels.
Version, short-source and latest tags must all publish the same signed digest;
latest is written last. An existing version or short-source alias with different
bytes is refused, requiring the appropriate new version or original candidate.
Main must still identify the release source before each write.

## Consumer evidence

Retain the image workflow run, source SHA, exact evidence artifact and registry
digest. Verify provenance for each retained JSON file, requiring the official
repository/workflow, main ref, exact source and workflow SHA, and hosted runners.
Compare the source-lock and SBOM SHA-256 values with the evidence from that
trusted source. For the image itself, use the fully qualified digest:

```text
gh attestation verify oci://ghcr.io/mario-andreschak/flujo@sha256:<manifest-digest> --repo mario-andreschak/FLUJO --predicate-type https://slsa.dev/provenance/v1 --signer-workflow mario-andreschak/FLUJO/.github/workflows/publish-image.yml --source-digest <source-SHA> --signer-digest <source-SHA> --source-ref refs/heads/main --deny-self-hosted-runners
```

Repeat with `--predicate-type https://cyclonedx.org/bom` for its SBOM. Pull that
exact digest and compare its Docker config ID, labels, platform and user with the
retained evidence. Preserve command output and exit codes. A moving `latest`
label, source tag or a local checksum does not prove artifact provenance.

The [GitHub attestation action](https://github.com/actions/attest) supports
registry digest and SBOM predicates. [Syft image targets](https://oss.anchore.com/docs/guides/sbom/scan-targets/)
catalog the container filesystem, while [Docker image push](https://docs.docker.com/reference/cli/docker/image/push/)
reports each published manifest digest.

## Acceptance still required

The publication regression tests use synthetic inventories and intercepted
Docker/GitHub commands. A real run must prove image build, live proxy smoke,
SBOM generation, hosted signatures, registry readback, alias digest equality and
installed operator journeys. Container OS vulnerability scanning and resolution,
worker-channel provenance, installer provenance and admin enforcement remain
separate acceptance work. No source test result supplies an external grade.

## Container process lifecycle

The official image runs the existing launcher through Debian's Tini with
subreaper mode. Compose also enables the runtime's init. This keeps adopted
tool descendants from remaining zombies after they exit, including when a
managed runner provides an outer init. Signals still go to the launcher;
FLUJO's generation-bound process ownership and shutdown behavior remain in
the application.

Run `node scripts/test-container-init.mjs IMAGE` against a locally built image
and repeat with `--outer-init`. The probe starts a synthetic HTTP process and
an independently exiting parent/descendant, verifies the live descendant's
process identity, requires its `/proc` entry to disappear after termination,
checks the listener stays alive, and checks graceful SIGTERM forwarding.
It uses an owned disposable container without network or host data. This
qualifies init behavior; it does not substitute for the FLUJO startup and
snapshot recovery smoke above. `--expect-zombie` provides a negative control
for an image that starts Node directly without an init.
