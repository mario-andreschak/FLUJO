# Public audit evidence

These records preserve the September 16 pre-fix findings, remediation checks and known limitations. They are historical local validation evidence, not proof that a later release commit passed the same checks. The failed Persona append-latency criterion remains a failure.

Before publication, exact originals were archived privately with a SHA-256 manifest. Public copies omit local user paths, private task identifiers and unrelated task metadata. Markdown source links are relative to this repository; original audit line labels describe the recorded pre-fix revision.

In JSON, paths beginning with `remediation/` or `persona-soak/` are relative names inside a local evidence bundle; `toolchain/` names the executable used. These raw logs, test outputs and snapshot files are retained locally and are **not included in this repository**. They are not public download links.

- `originalRawSha256` checksums the unchanged raw artifact or pre-sanitization summary retained locally.
- `sha256` for an included repository JSON file checksums its current public bytes. References to sanitized included files are refreshed when sanitization changes them.
- Source-file hashes describe the source that was validated. Snapshot and `observedSha256` hashes describe bytes at their recorded observation time, before publication edits. Neither is silently rewritten to imply a new validation run.

All measured counts, thresholds, outcomes and original findings are retained. Sanitization changes publication metadata and references only.
