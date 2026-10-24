# Feature surface acceptance

This matrix supports #572, #517 and #526 within epic #563. It preserves the
advertised local MCP workbench surface and distinguishes source checks from
installed-artifact and user evidence. It does not award a scorecard grade or
establish production readiness. The agreed rubric belongs to #564; the independent
pilot belongs to #577; release identities and reassessment belong to #565/#578.

## Evidence to retain for every candidate

Record the source commit, package version **and** npm tarball integrity/image digest/
installer checksum, OS, Node/runtime versions, clean disposable data-directory
identity, command, exit status, start/end time, failures/skips, and evidence hashes.
Package version alone does not identify the code installed. Keep credentials and
private workspace data out of public reports. A source/Jest fixture is not a
published artifact or a human observation.

| Surface | Minimum smoke on an identified installed candidate | Useful failure / retained behavior |
| --- | --- | --- |
| Models | Actual answer using OpenAI, Azure OpenAI, Anthropic, Gemini, xAI, OpenRouter, Codex, Ollama and each advertised subscription/CLI adapter | Missing credentials/runtime, model access, provider quota and cancellation remain actionable; a saved configuration is unverified until a real request succeeds. Account provisioning and paid runs need their separate authority. |
| MCP connection/install | Connect a harmless known fixture by stdio, Streamable HTTP and legacy SSE; exercise registry, GitHub and local-folder installation on disposable paths | Invalid command/URL, missing git/Python/uv, failed handshake and disabled server report errors; saved configuration is distinct from a successful handshake/tool test. |
| Complete tool inventory | Discover 128 tools over four pages; compare all names and schemas; select/test tool 128 with an explicit click | Later-page failure and repeated/endless cursors return an error, never a successful partial inventory. Model/App audience restrictions apply to every page. |
| Complex parameter forms | Open Firecrawl-like string/object and Playwright-like forms, edit valid and unfinished JSON, wait beyond the old 30-second interval, then explicitly refresh successfully and with a failure | No implicit invocation, update-depth error or parameter-editor remount. Edits, prior result and rendered MCP App survive same-server refresh. A successful empty inventory removes tools; a different server clears prior tool state. |
| Resources / prompts / MCP Apps | List/read a resource, list/get a prompt, render an opted-in App and exercise its permitted same-server tool | Unsupported capability, revoked App permission and model/App visibility fail usefully. Preserve sandbox/CSP and owner scope. Resources/prompts pagination and protocol-beta behavior require their own candidate checks. |
| Easy and visual graph | Create/save/reopen an agent; run a branch/loop/subflow and inspect the resulting conversation | Existing model/tool bindings, graphs, configuration and history survive upgrade. New guide controls do not remove graph editing. |
| Debugger / HITL | Breakpoint, step/resume/cancel; approve and reject a harmless tool request | Waiting approval remains distinct from failure/completion; rejection invokes no tool; history retains the observed decision. |
| Automations | Disposable cron/webhook/file/URL/MCP-poll triggers with success, failure and approval | Schedules require a running server. Worker startup/recovery and copied-snapshot suppression use Production's #553 contract. No fixture result implies autonomous reliability. |
| External endpoints | List a `flow-*` model and complete an OpenAI-compatible request; initialize/list/call the same configured server through its MCP proxy | Preserve streaming/cancellation, request IDs and scope. Security owns owner-session versus scoped-token migration; FACTORY/O/Brain/avatar consumers need their reviewed versioned auth contract. |
| Distribution / upgrade | Exact npm package, Windows installer/PowerShell path, Linux shell/source path and Docker candidate; upgrade a disposable legacy workspace, restart, compare configurations/history | Record artifact identities separately. Install/update/backup/restore failures must preserve user data and give a recoverable next step. #570/#578 own release-level acceptance. |
| Accessibility / languages | Keyboard-only first journey, screen-reader labels, 200% zoom, narrow viewport, all supported UI languages | Tool selector/timeout have associated labels. Unit label assertions do not prove keyboard, screen-reader, zoom or translated-layout acceptance. |

## Source regression checks

- `__tests__/mcp/toolDiscoveryPagination.test.ts`: all 128 definitions, complete
  audience filtering/late-page authorization, later-page error, opaque empty cursor,
  cycle termination and 1,000-page admission limit. This page limit bounds request
  count; it is not an arbitrary-response byte or RSS bound (#569).
- `__tests__/mcp/toolDiscoverySdk.test.ts`: real installed SDK client/server over
  its in-memory transport; complete definitions plus retained early/late output
  validators and task metadata. This is source protocol acceptance, not stdio/HTTP
  process-boundary or installed FLUJO browser acceptance.
- `__tests__/frontend/components/MCPToolRefresh.integration.test.tsx`: real manager,
  discovery hook, SchemaParamsForm and GlobalReferenceEditor with mocked discovery/
  invocation; same DOM nodes and a mounted App-frame test double survive pending,
  successful and failed refresh. All 128 menu entries are reachable and server
  changes clear prior state. This does not execute a real sandboxed iframe.
- The hook/manager/tester regression suites retain stale-response ownership, cache
  clearing, authoritative empty discovery, explicit refresh and prefill behavior.

Run the selected Node and jsdom checks serially with `scripts/run-local-jest.cjs`,
then changed-file ESLint and root typecheck. The integrated runner and
`jest.testMatch.mjs` canonicalize the checkout root and explicit suite paths,
including Windows managed paths containing `.codex`. Use the normal project
matches; the earlier broad `--testMatch` workaround belongs to source observations
before that repair. The runner rejects zero completed assertions, an omitted
explicitly selected suite, and a selected suite that completes no assertions.
Retain actual passed/failed/skipped counts and process exits; `--listTests` is
discovery only and cannot establish that assertions executed.

```powershell
node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/mcp/toolDiscoveryPagination.test.ts __tests__/mcp/toolDiscoverySdk.test.ts __tests__/mcp/toolVisibility.test.ts __tests__/mcp/mcpAppsNegotiation.test.ts __tests__/mcp/listServerToolsResilience.test.ts __tests__/mcp/testConnectionStreaming.test.ts
node scripts/run-local-jest.cjs --selectProjects jsdom --runInBand --runTestsByPath __tests__/frontend/hooks/useServerTools.test.tsx __tests__/frontend/components/MCPToolManager.test.tsx __tests__/frontend/components/ToolTester.test.tsx __tests__/frontend/components/MCPToolRefresh.integration.test.tsx
```

## Acceptance still required

The source slice starts from main `3511ba49514fe8cf525f5a22c16c3806bf3886ba`
(source package 3.46.2), inspected October 3, 2026. The existing September #517
release observations do not establish that this patch shipped. Keep #517/#526 open
until a reviewed integration and identified candidate reproduce the browser checks.

Full Windows/Linux builds, packed app/MCP process checks, genuine browser/iframe
screenshots, upgrade preservation, external client auth migration, the complete
matrix above, agreed novice/pilot observations and independent reassessment remain
separate gates. Schedule heavy checks with the coordinator. Do not treat source
test counts as feature adoption or an A- outcome.


## MCP protocol adapters (#1093)

The [October 12 support matrix](../mcp-conformance-1093-2026-10-12.md) records the
legacy/modern boundaries, source repairs and focused qualification. Measured
source-production sampling, subscription and Tool Tester browser evidence is
recorded there. Genuine OAuth and separate hosted/installed Windows/Linux and
combined release qualification remain open. Current
Windows packaged listing passed on #1056; #1050's original intermittent cause remains
unidentified. A later pass cannot establish its historical cause.

October 15 Tool Tester browser evidence
covers source-production SDK1 HTTP at 1440px and SDK2 modern HTTP at 390px. It
proves initialization/input/result ordering, same-server visibility, safe-link
success reporting, downloads, undeclared-host/frame refusal, revocation/remount
and cancellation of real pending tool work. It fixes a safe link opening with no
opener while incorrectly returning an error. No provider call is required by this
tool-only journey.

The later exact-port and restart evidence
supersedes the earlier loopback widening exception. [PR #1161](https://github.com/mario-andreschak/FLUJO/pull/1161)
preserves declared fixed ports and supports ephemeral-port changes through
**Reload app**, including failed-read retry and pending-call cancellation. Both
SDK generations pass two actual listener restarts each. Genuine OAuth and separate
hosted/installed release qualification remain open. Browser local-network permission was granted
only for each owned sandbox origin; no App CSP/permission setting was relaxed.

October 15 live OAuth preparation
adds genuine BankingMCP registration and real Slack consent-screen preparation,
with encrypted PKCE/client persistence and 16 constructed callback rejection/
replay checks on the production routes. No authorization-code exchange or real
refresh has completed. Slack's existing app is awaiting the action-time terms
confirmation in the current chat; BankingMCP instead requires a paid-trial
entitlement. Neither prerequisite is acceptance success, and no paid account is
required merely because that provider was examined. Both private app profiles
close and are removed; the shared connection configuration remains unchanged.
