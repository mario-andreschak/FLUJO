# Optional MCP source review acceptance

Issue #527 adds an explicit **Review source** action to Marketplace details and the GitHub installer. The user chose optional on-demand review. Existing human trust and execution consent remain required independently. The configured-model reputation assessment in #101 remains separate.

## Qualified source and engine

Application source was frozen at `8c4fb7aed05c21a6199eddf5ce3f34e13fe83347`, based on qualified integration #998 (`ccaa7f5e79774d6a4bb0ad5b02b61cb251f6cdb9`). Subsequent commits strengthened the local HTTP cancellation probe and repaired test fixtures; application source did not change.

The locally built engine is NVIDIA SkillSpector 2.12.0, upstream revision `c7958a3268d9498644b22edb75d0f051bbc8cbfc`, image configuration ID `sha256:8ba247101c2225fecdc183d46ca5743989f530e9d009d9f6f72c78034fe1dcd4`. Source archive and wheel SHA256 checks, digest-pinned Python/uv images, frozen dependency installation and refusal of dependency source builds passed. This is local acceptance, with no registry publication, signed provenance or comprehensive OS/Python CVE grade.

One default-heap production build passed with Next 16.4.0, five MCP builds, TypeScript and all 131 pages. Standalone MCP release validation and the relocated Codex import passed. Application/runtime checks used supported Node 24.19.0. Final fresh dependency installation invoked npm's CLI explicitly with that runtime, because the system npm PowerShell wrapper otherwise selects unsupported Node 22.13.1.

## Actual vendor and Docker checks

The local smoke exercised the vendor's clean and poisoned fixtures, a dangerous worker file beyond the README, an ordinary MCP repository without `SKILL.md`, and unavailable live dependency lookup. Findings and incomplete coverage remained visible, including a valid exit-1 report.

The observed scanner used UID 1000, read-only root and source volume, no network, init, dropped capabilities, no new privileges, resource bounds and no ambient provider credentials. Cancellation began only after an actual scanner container was running. Owned containers and the source volume were absent after cleanup. A candidate write marker was absent when sampled during scanning; that observation is not a lifetime execution trace. The static-only vendor invocation and source acquisition path do not invoke candidate code.

## Built HTTP and authority checks

An actual production server used a fresh private owner fixture with hashed authority. Missing/wrong owner credentials returned 401, foreign origin 403, locked installation 423, and invalid/extra/oversized bodies 400. Responses were not cacheable.

The real GitHub source fixture was `mario-andreschak/mcp-image-recognition`, revision `ffc59ec853d603bed520553545c294f4003c18f5`: 21 files and 37,377 bytes, source digest `2d7800a0af08ccf7c85ba5a3ae795c3a76c06d79b149d788ec1c982762634519`. The actual static/offline report was partial, with 26 findings, score 62 and HIGH severity; report SHA256 `18b7bacac241bb7cf31933aac1e4bba640c693193700f1e9e51461876a4426c3`. These are analyzer fixture outputs, not independently verified vulnerabilities in that repository.

A second HTTP request was disconnected after observing its running engine. The server cleaned up owned resources, refused a concurrent review, and recovered capacity only after cleanup. Owner policy bytes were unchanged and no execution approval was created. The private server stopped gracefully.

One earlier attempt reported unavailable before the cancellation stage. An unchanged retry after confirming public GitHub availability passed; the transient failure's root cause was not conclusively established.

## Regression repairs and limits

Full test type checking caught a negative archive test whose table spread file arrays into callback arguments. It now tests the complete file set, exact scanner refusal and zero Docker effects. A source fixture also received its correct heterogeneous response type.

The inherited protected-package runner suite exposed Windows fixture races after Jest timed out without cancelling asynchronous cleanup. Its affected cases now track and drain their own finally blocks before shared credentials or dependency trees can change. Windows test budgets allow fingerprint/ACL work; real SDK connection/call deadlines remain 10 seconds and security assertions remain intact. Failed pre-repair runs are retained in local evidence.

Coverage remains static and offline: no semantic model assessment, live OSV lookup, private source, installed registry dependency equivalence or running-tool discovery. Unsupported complete sources are refused rather than reduced silently. See [operator setup and interpretation](../guides/mcp-security-review.md).

Recoverable local evidence is under `C:/Users/Moe/.codex/tmp/flujo-skillspector-*`: engine build/smoke, production build, built HTTP, release, final canonical tests, full types and lint. The shared handover records final results, exact publication head and any live CI handle.
