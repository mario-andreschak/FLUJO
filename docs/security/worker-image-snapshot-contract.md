# Worker image snapshot restore contract

The immutable worker image must implement the [snapshot capability contract](snapshot-capability-contract.md). Application version, manifest format, workspace layout and worker protocol alone do not establish v2 encrypted restore. The Dockerfile declares these additional exact labels:

| Label | Value |
| --- | --- |
| `io.flujo.worker.snapshot-envelope-read-versions` | `1,2` |
| `io.flujo.worker.snapshot-default-limits` | `{"maxFileBytes":268435456,"maxUncompressedBytes":1073741824,"maxManifestBytes":8388608,"maxArchiveBytes":1082130432,"maxEncryptedBytes":1442844672,"maxMembers":65534}` |

The bounds label is canonical JSON in the shared contract's field order. `src/shared/snapshotTransfer.json` supplies release inspection and smoke expectations and is copied into the runtime image. These values describe default acceptance, not process-memory limits or a runtime with overrides. An absent label, v1-only list or altered bounds cannot acquire v2 qualification through a caller's configuration.

Before credential capture, the companion must validate the complete authenticated source advertisement and a separately qualified official target image selected by immutable digest. Bind its configuration, Linux/amd64 platform, non-root `node` user, official source, full build revision and application version to the qualification evidence. Retain `io.flujo.worker.snapshot-source=1` and the corresponding private-source consent and admission protections. A mutable tag, supplied metadata or source info response cannot establish another image's provenance or restore behavior.

Compare every effective source limit against qualified target limits before begin. Source limits exceeding target limits require independently qualified target configuration or refusal. Image inspection rejects either snapshot-limit override environment name, including values equal to the defaults. Machine/container configuration and secret overrides require their own effective-configuration proof; image default labels cannot establish that proof.

`scripts/image-release.mjs` checks the complete labels and configuration during candidate inspection, immutable revision reuse and registry readback. Evidence validation checks required labels before signing or promotion. Existing exact-source, signature, digest, registry readback and alias checks remain in place. Source tests model refusal before registry mutation; they do not perform Docker publication.

The cloud-worker publication workflow validates a newly built image before smoke. If an immutable revision already exists, it pulls that image and calls the same strict `inspectTestedImage` before running it or completing promotion. Both fresh and reused paths run two complete offline production worker smoke profiles:

- Default v2: exact AES-GCM AAD and encrypted-wire SHA-256.
- Explicit `--snapshot-v1`: historical AES-GCM and plaintext-ZIP SHA-256.

Each profile restores its synthetic snapshot, checks authenticated compatibility, starts bundled MCP, executes a real flow against a local mock model, retains results and restarts the worker without replay. Runs use the actual selected image, read-only container filesystem, bounded temporary storage, dropped capabilities and no external network or host workspace mount. Recovery equipment's separate opt-in profile is unchanged. Configuring these runs does not prove they have executed successfully on an installed image.

The separate `verify-cloud-worker-image.yml` workflow builds the exact pull-request head as a local Linux/amd64 candidate, inspects its immutable image configuration ID with the same strict release inspector, and executes both complete offline profiles before merge. It retains source/lock identity, inspection and actual profile logs. It has read-only repository permissions and performs no registry login, push, signing, promotion or deployment. Candidate execution verifies that selected local image's behavior; official registry provenance, readback and effective deployment configuration remain separate requirements.

This document carries forward the image-contract scope from #744/#745 using the current shared JSON and release inspector. It does not retain obsolete helper names, historical pass counts or an inferred whole-PR equivalence. Current source image-release tests, syntax and workflow parsing are distinct from actual Docker label parsing, paired private restore and immutable artifact execution. Full exact-source verification and installed image qualification remain gates; no image publication, deployment, human acceptance or independent external A− reassessment is claimed here.
