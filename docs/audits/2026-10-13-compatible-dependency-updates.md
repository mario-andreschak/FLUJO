# Compatible dependency updates and native clipboard acceptance

Existing Dependabot PRs #1134, #1136, #1137, #1138, #1139, #1141 and #1142 are qualified together on main `1aef61b40e231988a373763d8728fea42c76bffb`, through existing PR #1137. Their exact package-lock deltas change eight package records without unrelated version drift. Required locked dependency/peer ranges resolve, including the paired MUI updates, retained Slate 0.126.0 and cosmiconfig's nested YAML 1.10.3.

| Package | Previous lock | Qualified lock |
| --- | --- | --- |
| @mui/material | 9.4.0 | 9.5.0 |
| @mui/icons-material | 9.4.0 | 9.5.0 |
| slate-react | 0.131.0 | 0.133.0 |
| slate-dom | 0.131.0 | 0.133.1 |
| slate-history | 0.115.0 | 0.128.1 |
| yaml | 1.10.3 | 2.9.1 |
| @anthropic-ai/sdk | 0.132.0 | 0.133.0 |

Qualification reproduced synthetic paste changing the prompt and its history after the Slate update. `GlobalReferenceEditor` now explicitly rejects untrusted paste before Slate insertion or the caller's paste callback. Native text/image handling remains delegated normally. The existing negative assertion is retained and also checks that the callback is not invoked. A second failure was a stale Antigravity wizard expectation: the already-merged guided bundle uses Gemini 3.8 Flash High. Only the expected label/slug changed; key trimming, no-login-checkbox, callback count and adapter assertions remain.

## Validation

All commands ran locally through flujo-bash; the heavy phases held the existing process-held build lease. Node 22.23.3 and Next 16.4.0 were used. The installed Next TypeScript and production guides were read before source edits.

- Local typecheck passed in 62.423 seconds; source lint passed in 99.528 seconds. Changed test/harness lint also passed with zero warnings.
- Nine focused suites, all 100 cases, passed in 28.644 seconds (Jest reports 26.731 seconds). Coverage includes the real editor/history, connection wizard, Anthropic SDK and loopback HTTP streaming, tool-schema/prompt-cache behavior, MCP skill functions/protocol and YAML frontmatter verification.
- Inspected `npm run build` passed in 334.639 seconds, including the application and five MCP packages. It contains no image/container build.
- Existing `prompt-editor-browser-acceptance.mjs` passed against the actual production build, using the production owner issuer and an isolated private profile. Its current authentication and optional installed-browser support are restored; token-bearing browser requests are confined to the exact loopback origin. Browser: Chromium-compatible Edge 155.0.4283.45. Build ID: `WA-rP2NjTuhZrhiVQlmxf`.
- Four native browser journeys passed: English/Spanish at 1440px desktop and 390px phone. Each exercises rapid Select All/Left followed by clipboard paste and typing, Right collapse, Shift selection replacement, Undo/redo, reference-pill paste/removal, focus retention, Control/Meta Select All, and rejection of synthetic paste/Select All. All 36 rapid shortcut pairs were trusted and below the existing 100ms limit. Document scroll width equals viewport width in every case.
- Browser errors, external requests and provider requests: zero. The owned app stopped with exit 143; operator, data and secret fixtures were removed successfully through the same flujo-bash invocation.

These are measured phase timings; typecheck/lint/focused checks overlapped. No new regression assertions, support requirements or security gates were removed. Actual hosted-provider credentials/calls, broader suites, installed distribution checks, online CI, release validation and container builds were not part of this development qualification. No issue closure or new release is claimed.

## Bound inputs

SHA-256 of the qualification's working input bytes:

| Input | SHA-256 |
| --- | --- |
| package.json | d70051aa409eae59a3b4cdd65b130d4d6f84b705365d4912fcdb6bfcdce08a8f |
| package-lock.json | 5542101e0ab4c98b01a1fbe616cbfccb00025a7748a5fe07a8bb009311c44871 |
| GlobalReferenceEditor.tsx | b6d46ea6a7435754725db175cc7df12d201d9e81ba2354dca1f7bde6dc5e0160 |

The published candidate and actual main result must have the same qualified Git tree. Subsequent documentation and PR metadata do not change the qualified application inputs.

## Separate existing migrations

- #1133: react-window 2 removes `VariableSizeList` and `ListChildComponentProps`; `MeetingTranscript` also needs its v1 ref, height-invalidation, props and scrolling behavior migrated.
- #1135: parser 8.71.1 explicitly rejects TypeScript 7, and existing acceptance/configuration equipment consumes the compiler API absent from TypeScript 7. Retain TypeScript 6 while qualifying the other tool updates, or deliberately migrate the API consumers alongside the CLI.
- #1140: Undici 8 requires Node 22.19+, while the public runtime contract accepts Node 22.17/22.18. Retain Undici 7.30.0 until that existing compatibility migration is implemented and qualified.

These PRs remain implementation work; they are not external or approval blockers. Draft PR ownership and the existing Claude access hold remain separate.
