# Optional AI assessment of MCP repositories

Marketplace details and the GitHub installer offer **AI risk assessment** alongside the separate SkillSpector source review. Open the assessment, choose a saved text-model connection, optionally include source excerpts, and explicitly start it. No assessment runs while browsing, typing or choosing a model. Public GitHub signals and any opted-in excerpts are sent to the selected provider; its fees and privacy terms apply. Source excerpts default off.

The result is an advisory risk score from 0 (lower reported risk) to 100 (higher reported risk), a rationale and flags. Read the evidence identity and missing-coverage notices. Popularity, account age, issue ratios and a model's confidence do not establish safety. A score never checks the human trust checkbox, starts an installation or grants execution consent.

## Evidence and privacy

Public `https://github.com/owner/repository` URLs are supported. GitHub repository and owner identities are checked, HEAD is resolved once to a full commit SHA, and the receipt records capture time and a digest of the exact evidence supplied. Stars, forks, last-commit date, owner followers/public repositories/account age and the ratio of open to open-plus-closed issues are gathered. Issue searches explicitly exclude pull requests. Missing, rate-limited or incomplete results stay unknown; no credential fallback or invented zero is used. These separate API reads are a snapshot over the request, not an atomic view of GitHub.

When opted in, at most six source files provide at most 16 KiB each and 48 KiB total. Root README/manifests, declared JavaScript entries and common entry names are sampled from the pinned tree. Whole fetched blobs are limited to 128 KiB and checked against their Git content hash before UTF-8 excerpts are selected. Truncation, unavailable files, links, unsupported paths and binary/LFS bytes remain explicit. This is a sample, not a full-source or downloaded-package certification. Excerpt bytes are not returned to the browser or persisted as a report.

GitHub API responses and the complete assembled prompt have size bounds. Source acquisition has a 30-second deadline; model generation has a 45-second deadline and 2,048-token output cap; the overall operation has a 90-second deadline. Only one assessment is active across workspaces, with no queue or automatic rerun. Cancellation changes the provider signal and holds capacity until the call actually settles. Closing the panel or changing its repository, workspace, model or source choice discards pending results.

## Model boundary

Saved request-response text connections use the existing provider adapter seam in a restricted assessment mode: one physical request, no SDK/wrapper/parameter-negotiation retry, no capability lookup, no redirects, no model tools and no agent execution. CLI agents, fallback policies and non-text or mixed media connections are excluded. Native Gemini uses a bounded native REST transport within its adapter for this mode because the installed SDK does not offer the necessary redirect control; ordinary chat continues to use its existing path.

Repository content is confined to an untrusted evidence message. A fixed system instruction requests a strict `{score, rationale, flags}` schema. Tool calls, media, truncated finishes, extra fields, malformed/oversized JSON and provider errors produce an unavailable result. Findings are rendered as plain text. Prompt boundaries cannot guarantee that a model's judgment resists all injection, so the result has no authority to execute instructions or approve a server.

The selected saved model is checked again before dispatch; a changed destination or credential record stops the operation. Requests accept only repository URL, saved model ID and an explicit source-choice boolean. Existing owner, origin, workspace and encryption admission applies. No client-provided provider URL, API key, command or tool definition is accepted.

Local qualification includes deterministic HTTP model fixtures, actual public GitHub evidence and cancellation through the built route. Those fixtures prove transport and policy behavior; they do not prove semantic accuracy of a real configured model. Real-model judgment remains operator evidence, with no automatic paid acceptance calls.

GitHub behavior follows its [REST search documentation](https://docs.github.com/en/rest/search/search) and [API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). See also the separate [SkillSpector review](mcp-security-review.md), which is static and offline and makes no model call.
