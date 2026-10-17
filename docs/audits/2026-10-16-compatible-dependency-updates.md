# Compatible dependency updates and Gemini continuation context

Existing PR #1195 integrates the exact package deltas from #1192, #1193, #1196 and #1197 on main `37795ae42802750782e9000701a0123ac72cb8e2`. Only six locked package records change. All published integrity hashes, current Node/required peer ranges and focused GitHub reviewed-advisory queries for those six exact versions pass. Slate React requires Slate DOM >=0.133.6, so the Slate updates travel together.

| Package | Previous | Qualified |
| --- | --- | --- |
| nanoid | 3.3.19 | 3.3.20 |
| postcss | 8.5.29 | 8.5.30 |
| @google/genai | 2.28.0 | 2.29.1 |
| slate-dom | 0.133.5 | 0.133.6 |
| slate-react | 0.133.5 | 0.133.8 |
| slate | 0.133.3 | 0.133.7 |

## Compatibility repair

The upgraded Google SDK automatically continues generation and accumulates billing across HTTP hops. Two real-SDK/loopback adapter regressions reproduce FLUJO reporting 24 cumulative billed prompt tokens as input context when the initial prompt was 10. Context snapshots now read the SDK's initialPromptTokenCount while billing remains 24 input, 7 output and 31 total tokens. Ordinary responses retain the existing fallback. No provider route or tool authority changes.

Both regressions fail before the repair and pass afterward. Two adjacent real-SDK controls preserve an ordinary tool's thought signature and prevent Stop from resuming an available checkpoint. Fixture endpoints are loopback; the installed SDK, HTTP transport and SSE/continuation decoding remain real. Jest's host/VM dispatcher and plain-JSON realm bridges are fixture equipment.

## Validation

- 100 backend cases in 5 focused suites and 19 editor cases in 3 suites pass. The unchanged editor/Slate test result is reused after the backend-only repair.
- Typecheck, source lint and new-test lint pass. The inspected application build and all five MCP workspace builds pass; none invokes a container/image build. Installed Next production, PostCSS and Jest guides were read before edits.
- The actual production build passes four native editor journeys: English/Spanish at desktop 1440px and phone 390px. Each covers rapid Select All/Left followed by clipboard paste and typing, Right collapse, Shift replacement, Undo/redo, reference pills, focus retention and rejection of synthetic input. All 36 rapid shortcut pairs are trusted and within the existing 100ms bound. No horizontal overflow, browser error, external request or provider request.
- Browser fixture owner issuance uses production source. The owned app exits 143; its operator/data/secret fixtures are removed through the flujo-bash invocation. Source, lock, build and fixture identities are bound in the [machine receipt](evidence/compatible-dependencies-2026-10-16.json).

Measured phase timings (overlapping phases must not be added):

- typecheck: 62.848 seconds.
- lint: 104.827 seconds.
- focused-node: 5.262 seconds.
- focused-ui: 11.767 seconds.
- build: 354.492 seconds; build ID `HvGwcZSdKYQjQy5yflevw`.
- browser: 17.834 seconds.

No paid model/provider call, native Google account acceptance, installed distribution/CLI acceptance, broader/full suite, remote CI, container build or release is claimed. Existing #1091 acceptance remains open. The daily broad upstream/CVE/holds/historical review from October 16 is reused; this batch adds targeted release and reviewed-advisory checks.

## Delivery binding

The frozen application/test tree is `a93fc39096fc011e623cd287e7740abf39e35a47`. Package/source/test Git blobs and working input hashes are in the machine receipt; the added evidence files do not change those qualified inputs. Publish through existing PR #1195 and verify actual fetched main equals the complete delivered tree before closing superseded dependency PRs.
