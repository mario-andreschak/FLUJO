# Remote task request tags

New remote MCP task records previously stored the first 16 hex characters of SHA-256 over normalized arbitrary tool arguments. The field was described as non-reversible, but an observer who knows the surrounding request structure can validate low-entropy credential guesses against that fast digest. No active caller reads this field for duplicate detection or authorization. Restart matching instead uses the separate server identity, name and remote task ID.

New records now mint `request:<UUID>` tags using Node's cryptographic `randomUUID()`. Record creation never reads or traverses the legacy `args` input; the lifecycle no longer passes arguments into the record boundary. The string field remains named `requestFingerprint` for existing readers. Polling patches preserve the original tag, server identity and other immutable record identities; terminal records still reject late cancellation writes.

This patch directly follows the published 73-slice #611 candidate `b8cf905ff263559d8591f7dd839c2c75cf29f79f`. Its remote-task store Git blob is `ac1790fe08cbf50f845b0db128ff236ff3e0b85c`, identical to the separate #716 private-profile fixture branch's predecessor. Dependency manifests, lockfile, record version, server identity/restart semantics, storage paths and skip/assertion allowances are unchanged.

## Checks

Six focused Node assertions pass with zero skips. They exercise real record construction, patch and reload functions with the storage boundary controlled: repeated identical synthetic credential arguments produce independent opaque persisted tags; even an argument-property getter or a cyclic hostile object is never traversed; patches cannot retarget the tag/server identity; legacy field values remain explicitly legacy; terminal immutability is preserved. The first local discovery also selected the DOM project through an ignored discovery override and was refused by the strict runner. The corrected Node-only selection passes once and its receipt is `.tmp/remote-request-tags-jest-sealed.json`.

An independent bounded control lifts the exact three predecessor tag functions from frozen `b8cf905f` and the corrected tag function from the worktree, using actual Node crypto. A three-entry synthetic password dictionary has exactly one matching predecessor digest; the corrected opaque tag has zero matches and causes zero hostile argument accesses. Frozen source SHA-256 is `99f3249ed499280a007e9344ac595746ac22e7746a5e0988b976a03e71a28af9`; predecessor lifted function SHA-256 is `cd1b97223d4f00bb52f8a79ac73f56207b24a0e24a2357c54cc366afd095b531`; corrected lifted function SHA-256 is `5747f86b70dd31ea99dca6b4fc543a5c9b47be368b3dcd335a5d60bccd15ddb0`. The receipt is `.tmp/remote-request-tag-predecessor-control.json`. This is a function-level control, not an installed application or legacy-record migration.

Changed-file ESLint and diff checks pass. Full graph TypeScript/Jest, fresh root composition, installed task creation/restart, human exercise and independent Security review remain hosted/coordinator qualification. No full local Next build or broad Jest suite ran for this patch.

## Remaining privacy boundaries

Existing records and copies/exports may still contain old argument hashes; this patch neither rewrites nor removes them. Their immutable identities and restart behavior are preserved. The separate unkeyed server-identity hash still includes command arguments and URLs, which can themselves contain credentials. Env/header values are omitted, but that does not make the whole identity input non-secret. Comments now state this remaining limitation; a restart-compatible identity and legacy-record remediation design remains required.

CodeQL #149/#150, the complete secret/log/browser pipeline, authenticated migration, live revocation, default isolation, installed/human evidence and independent A- reassessment remain open. There is no scanner dismissal, rule weakening or claim that opaque new request tags close those wider findings.

Earlier automatic approval review rejected local scratch-image/context and an empty diagnostic fixture-directory removal with `blocked by policy`. Retained resources remain and no cleanup retry or success is claimed here.
