# Snapshot capability and acceptance limits

This source follows #736 at `9b0863194dc260c97e407c47990bf18c24fe6811`, retaining #732's recipient-encrypted writer and legacy restore reads. Manifest format 2, layout version 2 and worker ingress protocol 1 do not establish v2 encrypted-envelope support. New authenticated `GET /api/snapshot/info` reports two explicit fields inside `workerCompatibility`: `snapshotEncryption` and `snapshotLimits`. Its build revision is reported only when an explicit full `FLUJO_BUILD_REVISION` was supplied; no dirty checkout or absent revision is inferred. This metadata describes implemented source capability, not a qualified deployed image.

## Encryption negotiation

`snapshotEncryption` has the following exact fields:

| Field | Value / meaning |
| --- | --- |
| `format` | `flujo-workspace-encrypted` |
| `cipher` | `aes-256-gcm` |
| `writeVersion` | `2`; new source writes are encrypted only |
| `readVersions` | `[1, 2]`; accepted encrypted restore versions |
| `legacyPlaintextRead` | `true`; historical raw ZIP restore remains available without an envelope key |
| `recipientKeyRequired` | `true`; begin refuses before capture without it |
| `recipientKeyBytes` / `recipientKeyEncoding` | `32` / `base64`; fresh random bytes encoded canonically |
| `v2Aad` | `flujo:workspace-snapshot:v2` |
| `v2Digest` | `sha256-encrypted-wire` |
| `v1Digest` | `sha256-plaintext-zip`; historical bridge digest contract |

The companion sender must explicitly check these fields before a credential capture, and require `encryptionVersion: 2` in begin/status. Absent or unsupported encryption capability requires an upgrade; it must not infer v2 from a Cap1/image/manifest label or silently fall back to a raw credential ZIP. Existing cloud clients send no recipient key and receive the fixed 400 refusal from #732. These clients remain compatible with their older native source; they are not compatible with this new capture contract until paired upgrades are applied. Existing v1/raw restore reads remain supported. The cloud owner must separately establish v2 support for the selected immutable worker image; a source info response does not prove another image's implementation.

Generate the random recipient key before `POST /api/snapshot/begin`, retain it separately, and send `{recipientKey, flowIds?}` as JSON under the existing dedicated control bearer and selected workspace. Begin's existing body acceptance limit is 16 Ki UTF-16 code units after reading its text, and flow selection remains 1–100 IDs of at most 256 code units each. The API proves canonical encoding and length, not entropy or independent retention. The sender keeps the exact downloaded encrypted bytes, advertised SHA-256 and independently retained key, and supplies those as worker snapshot file, `FLUJO_WORKER_SNAPSHOT_SHA256` and `FLUJO_WORKER_SNAPSHOT_KEY`. It must stop applying another envelope after download. No key is added to public status, compatibility metadata or the envelope.

## Shared limits

Capture, writer, envelope reader and restore now share a limit implementation. The two existing environment overrides accept positive safe integers; invalid values use the existing defaults consistently, and arithmetic overflow receives a fixed refusal. Source capture no longer interprets an integer prefix such as `16KiB` differently from restore.

| `snapshotLimits` field | Default / contract |
| --- | --- |
| `maxFileBytes` | 256 MiB, overridden by `FLUJO_SNAPSHOT_MAX_FILE_BYTES` |
| `maxUncompressedBytes` | 1 GiB, overridden by `FLUJO_SNAPSHOT_MAX_BYTES` |
| `maxManifestBytes` | 8 MiB |
| `maxArchiveBytes` | `maxUncompressedBytes + maxManifestBytes`, a separate compressed ZIP acceptance bound |
| `maxEncryptedBytes` | `4 * ceil(maxArchiveBytes / 3) + 4096`, including base64 padding and envelope overhead |
| `maxMembers` | 65,534 including ZIP directories; ZIP32's 65,535 sentinel remains unsupported |

The default encrypted-wire bound is 1,442,844,672 bytes, not the 1 GiB logical file total. A cloud client may impose a smaller wire limit and must check the actual session size and bounded downloaded bytes against it. Source and worker configuration can differ, so successful source capture does not imply acceptance by a differently configured recipient. The companion must compare the worker's qualified limits too.

Capture bounds recorded files and the serialized manifest. Writer checks all ZIP members before compression/staging, clears its compressed plaintext buffer on refusal, and rejects an oversized generated ZIP or wire envelope before persistence. Restore retains authenticated decryption, wire-digest verification, member/manifest/size/link/path validation before writes. The shared 65,534 member bound matches the existing ZIP32 reader's actual accepted range; lowering its nominal 100,000 constant does not admit ZIP64 or remove an accepted count. These are acceptance bounds. JSZip, traversal and JSON serialization still allocate before some validation; this is not a complete streaming or memory budget guarantee.

## Evidence and remaining qualification

Eight selected Node suites pass 110 tests, zero failures and zero skips. The actual authenticated info/begin/download composition obtains the advertisement before capture and decrypts the served envelope with independent Node crypto using its advertised AAD. Tests cover configured limits, padded base64, invalid values/overflow, member-directory accounting before staging, oversized manifest, generated ZIP refusal before persistence/owned buffer clearing, wrong key/tampering/downgrade, legacy reads, mutation lifetime, cancellation, expiry and finalize cleanup. The info/route fixture replaces workspace wrapping and business capture collection; it does not qualify installed authority or live credential inventory. Receipt: `.tmp/snapshot-capability-qualified.json`. Changed-file lint, smoke script syntax and diff checks pass. No test baseline or skip allowance changes.

An exact predecessor function control used #736 writer blob `cf596931fe69255ec880d2ba22c4b650937595ad`, envelope blob `6721835cbd676d4ef78cabe08e73cfd5eb67713b` and compatibility blob `80f28cf2e590e15fed5f52cbffadd2f6607b40a9`. Its writer function SHA-256 is `0022c66a7011930972e0cf80010426c9acbe0819d7a955e51a6da274e44cc865`. A real JSZip with 20,001 directory members and zero logical file bytes produced a 10,137,896-byte ZIP and a physical 13,517,313-byte encrypted artifact, despite an 8,388,609-byte receiver ZIP bound. The frozen reader refused it. The current writer, using the same real ZIP, refused with `SIZE_LIMIT`, made zero persistence calls and left its staging directory absent. Owned predecessor cleanup was also observed. This is a source-function control with actual crypto/physical persistence, not a live capture or installed application receipt. Receipt: `.tmp/snapshot-capability-predecessor.json`.

The installed cloud-worker smoke now checks the explicit encryption fields and the served wire bound, but has not run against an installed image here. Hosted full types/business tests, paired cloud client, immutable worker-image capability and Linux/Windows installed restore/restart remain gates. Preserve the combined root's later private-source consent and cross-process lease protections when integrating these deltas. No cloud repository changes, live provider/Fly operations or deployment are included.

Durable private migration/new active key, encrypted recovery backup, journal/effect-generation admission, atomic integrity commit, resume/rollback, credential-free ordinary exports, browser pairing, isolation/default grants and human/external reassessment remain open. Epic #563 / #567 and the A- outcome remain open. No scanner finding is dispositioned or claimed closed.
