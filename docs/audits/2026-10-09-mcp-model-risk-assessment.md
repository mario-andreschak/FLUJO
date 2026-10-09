# Model-based MCP risk assessment acceptance

Issue #101 now has an explicit optional assessment action in Marketplace details and the GitHub installer. It uses a selected saved request-response text model, public GitHub signals and source excerpts only when opted in. The score remains advisory; human trust and execution consent are separate.

Application source is committed at `32afd5b08f2b8ffbb689252713d9d8f75744c24f`, based on qualified SkillSpector PR #1004 (`f42d3d10d9b7c40504b2492f1486f9a6d54ea484`). Later `5ba306da` changes only local smoke cleanup. Published parent heads remain unchanged.

One default-heap production build passed on supported Node 24.19.0 with Next 16.4.0, five MCP builds, TypeScript and all 132 pages. An earlier full type check caught a missing UI type-predicate annotation. The correction changed only the annotation; installed TypeScript proved emitted JavaScript byte-identical before/after (SHA256 `6ec58fdd053caf920b4e413854671b2da7967ab9764ac96bf7d1893a0d7c3ac0`). Final full source/test TypeScript passed against the final committed source. Full source and changed-test/script lint, standalone release validation and relocated Codex import passed.

Canonical verification passed 133 contracts, 31 backend suites / 560 tests and six frontend suites / 170 tests. Coverage includes exact public identities, bounded/chunked GitHub reads, issue-only counts, missing signals, pinned blob verification and opt-out behavior; selected-model/credential/destination checks; strict output, tool/legacy-function/media/transcript rejection; cancellation retaining capacity until settlement; and UI identity/privacy/lifetime fences and seven locales. Existing consent and clone callbacks remain unchanged.

Seven adapter-related suites / 154 tests separately exercised ordinary behavior and actual local HTTP transports. OpenAI, Azure, Responses, Anthropic and native Gemini assessment paths sent one request, did not retry 503 responses or follow 307 redirects, forwarded real cancellation and output-token bounds, and exposed no tools. Anthropic skipped its otherwise unbounded model-capability lookup. Native Gemini's restricted REST path verified native wire format and a 128 KiB transport-body bound. General OpenAI/Anthropic SDK bodies remain SDK-buffered; their provider token caps and the service's 12 KiB final JSON/schema cap are not a hard raw-response-body bound. Ordinary chat retains its existing SDK behavior.

## Actual built route

The production HTTP smoke used a fresh private owner fixture with real USER initialization/authentication, hashed owner authority and encrypted saved model credentials. Missing/wrong owner returned 401, foreign origin 403, locked installation 423 and invalid/oversized bodies 400. Unsupported saved models produced no provider request. Valid responses were not cacheable.

The public evidence fixture was `mario-andreschak/mcp-voice`, revision `e8a291b7ec064761701c6315a5db5fc5cef8fb3d`, captured at `2026-10-09T18:40:40.091Z`. It supplied validated repository/author metadata, zero open and closed issues (undefined ratio), and one 48-byte source sample. Evidence digest: `b05b75329b6d6d1e4c9effd05c61d200abd00a698f1afa4fddcaf6a2e7fe9f93`; report digest: `e839e9af0a6bdeaffa4caad939433c81b100943a93a55352ae87fb3f4fbda9c7`. The sample is explicitly limited; other GitHub reads are separate snapshots.

The provider was a deterministic local OpenAI-compatible HTTP fixture, using the genuine restricted adapter and a saved model selected through the actual application API. It verified the model, token bound, system/data message separation and absence of tools. Its score 43 is a fixture output, not real-model semantic accuracy or a vulnerability judgment about the repository. No paid inference was used.

A second actual provider request was held open before browser-style HTTP disconnect. The provider socket closed, a concurrent assessment was refused, capacity recovered, and a subsequent source-opt-out assessment sent no source files. Exactly three provider requests served the three assessments. Owner policy bytes stayed unchanged, no execution approval file was created, the application stopped gracefully, and the owned provider/private fixture were cleaned up.

## Limits and recoverability

Public signals and any opted-in excerpts go to the selected provider, with its fees/privacy terms. Popularity and a model judgment cannot establish safety; prompt injection can affect judgment despite having no tool or approval authority. Private repositories, CLI agents, fallback policies and non-text/mixed-media connections are unsupported. Evidence acquisition/model/overall deadlines are 30/45/90 seconds; cancellation retains the global slot until work settles. Reports and excerpts are not persisted by this feature.

Local logs and receipts are `C:/Users/Moe/.codex/tmp/flujo-model-risk-*`, including the type-erasure receipt, canonical tests, build, full types, lint, release and actual HTTP smoke. The shared handover records publication head, hosted result and ownership. [Usage and boundary details](../guides/mcp-model-risk-assessment.md) document the operator-facing behavior. Issue closure waits for delivery into main.
