# Development tooling and wave-history browser acceptance — 2026-10-12

Existing PR #1065 is narrowed to Jest and jest-environment-jsdom 30.5.2 and Playwright 1.64.0. The mixed proposal's TypeScript 7 compiler API/parser incompatibilities and ESLint 10 plugin peers remain held; Node 22 typings remain aligned with the supported Node 22.17/24.2 runtime floor. Main's MUI 9, MCP Apps 2, Next 16.4 and shipped Patchright 1.63.0 graph is preserved. No security remediation for the historical dependency holds is claimed.

Qualification includes main `d827a852` and its startup/conversation recovery repair. The conversation-summary file-race fixture initially failed because its workspace mock lacked the newly used cache key. The mock now provides a distinct key per temporary workspace; all descriptor, rename, cache and malformed-file assertions remain intact.

Local typecheck, lint and the inspected application/MCP build passed. Sixty-four focused tests cover runner discovery, dependency identity, Node/jsdom execution, MCP process lifetime, wave grouping, ChatHistory, workspace migration/readiness and conversation-summary file races. An actual Jest watch process ran its selected fixture, observed a file change and reran successfully; that owned noninteractive process was then stopped. Full suites, online CI, images, installed-package and release checks remain deferred to release pre-flight.

## Issue #220 acceptance

The current target is `ChatHistory` plus `ConversationTree`; the historical `WaveTree` is no longer the rendered component. Two isolated applications, one using the normal development launcher and one using the built app, each passed 24 browser checks at 1280×900 and 390×844. The applications read 37 persisted synthetic conversations and four disabled executions from their own workspaces. The scheduler was paused throughout.

- Two runs remain distinct, with collect → edit/review fan-out and edit → publish nesting. Keyboard node collapse affects only the selected run; expansion restores its children.
- Group collapse survives reload. Ad hoc and Archived buckets remain last and flat.
- Empty responses, HTTP 503 and a failed wave transport each leave all 37 conversations available in flat fallback buckets. Restoring the actual endpoint and reloading restores the nested history.
- `/waves` opens in Day view. Explicitly opening Playground renders the same collect → edit/review and edit → publish relationships as the persisted chat parent links.
- The current depth-20 cap and per-path cycle guard terminate as implemented by ConversationTree. Both orphaned cycle nodes become roots, with a bounded two-row chain per root. Deep rows retain the component's existing clipping behavior; this acceptance does not claim a new deep-tree layout.
- No page errors or document/sidebar horizontal overflow occurred.

This completes the outstanding unavailable-wave reload and current Waves graph cross-check. It verifies browser rendering and interaction; it does not claim real provider/scheduler spawning, independent human testing or a physical phone run.

The [receipt](evidence/development-tools-wave-220-2026-10-12/receipt.json) records the qualified source tree, build ID, separate measured timings and complete check names. Screenshots retain the [phone hierarchy](evidence/development-tools-wave-220-2026-10-12/phone-hierarchy.png), [phone fallback](evidence/development-tools-wave-220-2026-10-12/phone-unavailable.png), [phone graph](evidence/development-tools-wave-220-2026-10-12/phone-graph.png), [desktop hierarchy](evidence/development-tools-wave-220-2026-10-12/desktop-hierarchy.png) and [desktop graph](evidence/development-tools-wave-220-2026-10-12/desktop-graph.png). Development browser, production browser, build and other checks overlapped with independent work; their durations must not be summed as elapsed run time.
