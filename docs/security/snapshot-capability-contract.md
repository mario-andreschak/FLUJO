# Snapshot capability and acceptance limits

Authenticated `GET /api/snapshot/info` reports `snapshotEncryption` and `snapshotLimits` inside `workerCompatibility`. Their default source is `src/shared/snapshotTransfer.json`; `snapshotTransfer.ts` resolves effective source limits. Manifest format 2, workspace layout 2 and worker protocol 1 alone do not establish encrypted-envelope support. A build revision is reported only when a full `FLUJO_BUILD_REVISION` is supplied. The advertisement describes this source, not a separately selected installed image.

## Recipient encryption

The closed encryption contract contains these exact fields:

| Field | Value |
| --- | --- |
| `format` | `flujo-workspace-encrypted` |
| `cipher` | `aes-256-gcm` |
| `writeVersion` | `2` |
| `readVersions` | `[1, 2]` |
| `legacyPlaintextRead` | `true` |
| `recipientKeyRequired` | `true` |
| `recipientKeyBytes` | `32` |
| `recipientKeyEncoding` | `base64` |
| `v2Aad` | `flujo:workspace-snapshot:v2` |
| `v2Digest` | `sha256-encrypted-wire` |
| `v1Digest` | `sha256-plaintext-zip` |

The sender generates a fresh random 32-byte recipient key, retains it independently, and sends `{recipientKey, flowIds?}` to `POST /api/snapshot/begin` using the dedicated control bearer and selected workspace. Authorization precedes body access. Body admission counts actual bytes and refuses beyond 16 KiB; flow selection accepts 1–100 nonempty IDs of at most 256 UTF-16 code units and deduplicates them. Missing keys, including when an ambient snapshot key exists, and noncanonical base64 keys receive a fixed 400 response before capture. Encoding validation establishes length and canonical form, not entropy or independent retention.

New public begin requests produce v2 recipient-encrypted artifacts. Internal capture helpers retain their separate legacy/plain use cases; they do not relax public ingress. The key is pinned during capture without modifying the ambient key. Public session responses report `encryptionVersion`; they omit the recipient key and internal paths. Download returns exact encrypted bytes with `application/vnd.flujo.workspace-snapshot+json`, content length, wire SHA-256 and encryption-version headers. Finalize, abort and expiry retain the coordinator's ownership and cleanup rules.

The sender must check the complete negotiated contract, session identity/version, actual size and wire digest. It supplies the unchanged wire artifact, independently retained recipient key and wire SHA-256 to the worker snapshot inputs. Reformatting the JSON changes its v2 wire digest even when the encrypted payload is unchanged. Applying another envelope or supplying the plaintext digest does not implement this contract. A source advertisement cannot qualify a different target image; see [worker image contract](worker-image-snapshot-contract.md).

The bounded reader accepts historical v1 envelopes with their plaintext-ZIP digest and raw legacy ZIPs with their ZIP digest. V2 requires the exact AAD and encrypted-wire digest. Version substitution, absent/wrong AAD and invalid authentication fail before restore publication. Legacy read support does not permit downgrading a negotiated v2 transfer.

## Effective bounds

| Field | Default / meaning |
| --- | --- |
| `maxFileBytes` | 268,435,456; each uncompressed file |
| `maxUncompressedBytes` | 1,073,741,824; aggregate uncompressed file bytes |
| `maxManifestBytes` | 8,388,608; serialized manifest |
| `maxArchiveBytes` | 1,082,130,432; ZIP acceptance bound |
| `maxEncryptedBytes` | 1,442,844,672; encrypted wire acceptance bound |
| `maxMembers` | 65,534; files and directories |

`FLUJO_SNAPSHOT_MAX_FILE_BYTES` and `FLUJO_SNAPSHOT_MAX_BYTES` accept canonical positive safe integers. Invalid values and arithmetic overflow fail closed with a fixed error. The derived bounds are `maxArchiveBytes = maxUncompressedBytes + maxManifestBytes` and `maxEncryptedBytes = 4 * ceil(maxArchiveBytes / 3) + 4096`. Prefix parsing, fractional values and silently substituted defaults are not supported.

Capture bounds files, logical totals and the serialized manifest. Both capture and archive writing count directory entries against the member bound; writer preflight rejects excessive members before staging or compression. ZIP32 sentinel/ZIP64 support is not inferred. The streaming writer enforces actual ZIP and wire byte counts incrementally and removes failed owned staging through its archive wrapper. It does not assemble a whole plaintext archive or whole base64 string. Capture and restore use bounded authenticated ciphertext-only temporary stores and preserve admitted descriptor identity, source boundaries and recipient-key ownership. These acceptance bounds are not a universal process-memory guarantee: manifest serialization and ZIP metadata still allocate.

Restore authenticates the envelope and validates all ZIP members, paths, manifest hashes, CRCs and declared sizes before workspace publication. A source configured with larger limits requires a separately qualified recipient configuration or refusal before capture. Default image labels cannot qualify runtime overrides.

## Qualification scope

Source fixtures cover real v2 writer/reader round trips, wrong digest domains, changed JSON wire bytes, downgrade/wrong-AAD rejection, legacy reads, setup cleanup, directory-member preflight, oversized manifests, invalid configuration and overflowing bounds. Archive/coordinator/restore suites additionally exercise credential transfer, cancellation, mutation, download identity and cleanup. A passing fixture proves only its exercised scope and exact source; tests using replaced business collection do not establish installed authority.

This document restores the contract scope from older #740 while reflecting the current bounded implementation. It does not import historical pass counts or claim all older controls are preserved. Exact-head full TypeScript and scoped tests, paired private/large transfer, installed Linux/Windows artifacts and immutable image execution remain separately tracked qualification gates. Human acceptance and independent external reassessment remain NO; epic #563 and the accepted A− outcome remain open.
