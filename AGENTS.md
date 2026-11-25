# Repository hygiene

Keep generated run records, provider traces, screenshots used only as proof,
agent handovers and media production projects outside this repository. Commit
media only when a published page or maintained product guide uses it. Reuse
existing screenshots rather than committing identical copies.

Perform cleanup and file deletions through the flujo-bash MCP. Keep the primary
development checkout on `main`; remove temporary branches after delivery.

`npm run check:repo-hygiene` enforces the file rules above.

# Issues kept for newcomers

Leave issues labelled `good first issue` to first-time human contributors. Do
not fix them in an agent session unless Mario asks for that exact issue. When
one closes, open a replacement and update `docs/contributing/starter-backlog.md`.

# Corrections become checks

When a mistake comes back, or a reviewer corrects one, fix it where it cannot
return. Take the first of these that works:

1. Code: change the API, types or folder layout so the wrong code cannot be
   written.
2. A check: a lint rule in `tooling/eslint-plugin-flujo`, a type or a test.
   Its message says how to fix the cause, never how to silence it.
3. Verification: run the app and check what the user sees
   (`.claude/skills/verify-flujo/SKILL.md`, `docs/feature-map/`).
4. Prose here or in a skill, only for calls that need judgment.

Before you call a change a user can see done, check it in a throwaway FLUJO with
the `verify-flujo` skill and keep the proof.

Then add a row to the table. The recipe is `.claude/skills/correct/SKILL.md`.

Code that already broke a rule when the rule arrived is listed in
`eslint-suppressions.json`. That list only shrinks: ESLint fails on entries
that are no longer needed (`npm run lint:prune` removes them) and
`npm run lint:ratchet` fails when it grows. Never run eslint with
`--suppress-all`. A real exception goes on its own line with a reason:
`// eslint-disable-next-line <rule> -- <why>`.

Write code that needs no comment, and never use a comment to explain away a
workaround.

| Rule | Enforced by |
|---|---|
| Fix the cause; no comments that justify a workaround | `flujo/no-workaround-comment` |
| Every lint or type exception names its rule and reason | `flujo/disable-needs-reason`, `@typescript-eslint/ban-ts-comment` |
| No `as unknown as` casts | `flujo/no-double-cast` |
| Keep work off the event loop: no synchronous file calls in `src/` | `flujo/no-sync-fs` |
| No raw timers in UI code; use `src/frontend/hooks/timing.ts` | `flujo/no-raw-timers` |
| Read an MCP server's startup error only in `src/utils/mcp/startupFailureHint.ts`; Python and Node.js word a missing file or package differently | `flujo/no-adhoc-startup-error-match` |
| Effects, refs and state follow React's rules | `react-hooks/*` in `eslint.config.mjs` |
| `backend`, `frontend` and `shared` import only what their layer allows | `__tests__/architecture/importBoundaries.test.ts` |
| Repository hygiene | `scripts/check-repo-hygiene.mjs` |
| Tests run only on a Node.js version the app supports | `assertSupportedTestRuntime` in `scripts/local-test-dependencies.cjs`; `__tests__/scripts/localTestDependencies.test.ts` |
| Every page has exactly one feature map entry | `scripts/check-feature-map.mjs` |
| A reply that reaches the output length limit is a finished, cut-off reply (`finish_reason: 'length'` and a soft chat notice), never a run error; its tool calls never run (`guardCutOffToolCalls` wraps every adapter) | `__tests__/model/cutOffReply.test.ts`, `__tests__/model/geminiSdkContinuation.test.ts`, `__tests__/model/selfHostedOpenAiCompatible.test.ts` |
| Whether a server is OpenAI's own is decided from its address (`isOfficialOpenAiEndpoint`), never from the provider name; a self-hosted server saved as "openai" gets its messages in the order written | `__tests__/model/openaiExplicitPromptCaching.test.ts`, `__tests__/flow/selfHostedServerRuns.test.ts` |
| Every OpenAI-compatible server is asked for token counts and read in its own spelling (`readOpenAiCompatibleUsage`); a call without counts shows "not reported", never 0 | `__tests__/model/selfHostedOpenAiCompatible.test.ts`, `__tests__/flow/selfHostedServerRuns.test.ts` |
| Every API route has one multi-user kind (`workspace`, `host`, `admin`, `account`, `protocol`); routes that start programs are `host` or `admin` | `__tests__/accounts/routeCapabilities.test.ts` |
| A workflow job that can publish or sign first requires the exact-commit `main` verification run | `assertReleaseVerificationGates` in `scripts/workflow-contract.mjs` (its exception list only shrinks) |
| Every open security alert is fixed or has a written reason that expires | `npm run check:security-response` with `docs/security/alert-triage.json` |
| Release evidence pages come from the collector, never from hand edits | `npm run evidence:release`; `scripts/collect-release-evidence.test.mjs` rebuilds each page in `docs/quality/release-evidence/` from its saved answers |
| A package install runs only the install and build commands the person reviewed | `reviewDigest` in `installPackage.ts`; `__tests__/packages/installPackage.test.ts` |
| Every shipped form (npm, Windows installer, Docker) runs the same backup, restart, upgrade and restore checks before release | `assertPackagedAcceptance` in `scripts/workflow-contract.mjs` |
| App code reads website files only from `githubpages/oauth/client-metadata.json`; installers and the image leave the rest out | `tests/installer-repository.test.mjs` |
| A new user can still connect an AI, test a tool, build and run an agent and reuse it | `npm run journey:first-use` on a throwaway FLUJO (`scripts/first-journey/run.mjs`) |
| Multi-user mode stays opt-in: without `accounts/accounts.json` no new file is read or created and no new check runs | `__tests__/accounts/optIn.test.ts` |
| Code that starts a program on the server checks host access right before it starts (multi-user mode) | `__tests__/accounts/hostAccessStartPoints.test.ts` |
| Copying into another workspace takes only listed fields; a new model, MCP server or flow field fails the type check until it is sorted as copy, scrub or drop, so no new secret field can travel | `satisfies Record<keyof …>` field lists in `src/backend/services/sharedItems/teamCopy.ts`; `__tests__/sharedItems/teamCopy.test.ts` |
| A save never silently replaces someone else's newer save of a shared flow, model or MCP server (multi-user mode) | `checkBaseRevision` in `src/backend/services/sharedItems/guard.ts`; `__tests__/sharedItems/twoEditors.test.ts` |
| Team roles give exactly their actions: owner all, member read/edit/run, viewer read; outsiders get "not found" | `__tests__/accounts/teamMatrix.test.ts` |
| Persona runtime cleanup writes only with a grant from the rollout switches | `PersonaRuntimeRetentionWriteGrant` argument of the compactors in `compactRuntime.ts`; `personaRuntimeRetentionSweep.test.ts` |
| The shareable diagnostic report holds only versions, counts and labels from fixed lists, never names, text, paths, addresses or keys | `normalizeDiagnosticReport` in `src/shared/types/diagnosticReport.ts`; `__tests__/diagnostics/diagnosticReport.test.ts` |
| A workspace without its key file (`db/encryption_key.json`) is locked only when it holds encrypted secrets, never just because it runs on a worker | `findStoredCiphertext` in `src/utils/encryption/storedCiphertext.ts`; `__tests__/encryption/missingMetadataLock.test.ts` |
| A subscription bar never shows a made-up 0% or 100%; every known provider answer has a fixture with the text and colour it must show | `__tests__/model/fixtures/claudeAllowanceFixtures.ts`; `__tests__/frontend/components/AllowanceFixtures.test.tsx` |
| Private approval reads wait and read again after a short-lived Windows file lock, helper failure or torn read, using `src/utils/transientFileRetry.ts`, before they refuse | `__tests__/mcp/privateApprovalRetry.test.ts` |
| MCP launch fingerprints and owner-approval digests compare a server config only as it is launched (secrets decrypted, globals filled in), through `launchForm()` in `src/backend/services/mcp/launchForm.ts`, never the saved encrypted text | `__tests__/mcp/launchFormCallers.test.ts`, `__tests__/mcp/secretEnvLaunchApproval.test.ts` |
| The split MCP SDK packages and Apps share one `@modelcontextprotocol/core`; bump core with client and server | `__tests__/mcp/sdkPackageAlignment.test.ts` |
| Tool approval has one gate: read the setting with `requireApprovalOf` (missing is off), ask only through runFlow's pause or `toolApprovalGate.ts`, and apply answers only at the fixed decision points | `flujo/single-tool-approval-gate`; `__tests__/flow/toolApprovalGate.test.ts`, `__tests__/chat/respondApprovalGate.test.ts` |
| A store read that fails never becomes a write of an empty store: retry with `src/utils/transientFileRetry.ts`, then refuse the change | `__tests__/scheduler/pendingApprovalsStore.test.ts` |
| MCP sign-in follows the 2026-07-28 authorization rules in both SDK generations (challenge first, no made-up scope, S256 checked) | `__tests__/mcp/oauthAuthorizationConformance.test.ts` |
| Claude Agent SDK runs keep FLUJO's approval as the only tool gate: default permission mode, no settings files, no allow list, and every tool handler checks FLUJO's decision | `__tests__/model/claudeSdkAuthorityArgs.test.ts` (installed SDK, fake Claude Code); `__tests__/model/claudeSubscriptionSdkBoundary.test.ts` |
| A private Antigravity CLI home pins every CLI default that can skip FLUJO's approvals (newer CLIs default to Auto mode) | `__tests__/model/antigravityCliRuntime.test.ts` |
| A reopened Antigravity conversation gets the prompt only after the CLI confirms its id; an unknown id silently starts an empty one | `__tests__/model/antigravityCliProcess.test.ts`, `__tests__/model/antigravityCliIntegration.test.ts` |
| A context summary never lets a model alone decide which user corrections or prohibitions survive, and never drops the exact receipt of an action that already ran | `requiredInstructionIds` in `src/backend/execution/flow/compaction/standingInstructions.ts`; `__tests__/model/compactionFidelity.test.ts` |
| A burst of chat requests waits its turn (`src/utils/capacityWaitQueue.ts`); none is refused because others arrived together | `__tests__/chat/parallelChatBurst.test.ts` |
| A Codex SDK/CLI bump re-records the real app-server messages (`npm run record:codex-protocol`, no account) and FLUJO's conversation code must still accept them | `__tests__/model/codexAppServerProtocolReplay.test.ts` |
| A resumed Claude session gets each turn's per-turn instructions exactly once and keeps its conversation; changed stable instructions start a new session; a resumed turn leaves parked Claude processes alone. Re-check on every Agent SDK upgrade | `__tests__/model/claudeSessionPromptResume.test.ts` (installed SDK with its bundled Claude Code and a stand-in model service on this machine) |
| A file added to a chat is never dropped silently: the model gets its content or a short note, and a model that cannot read a format gets a note or the PDF's text | `__tests__/frontend/components/ChatInputAttachments.test.tsx`, `__tests__/model/chatAttachmentModelInput.test.ts`, `__tests__/model/mediaHandoff.test.ts` |
| Each chat keeps its own state (such as its project folder) in a record beside it, never in a shared capped list; deleting a chat deletes every record kept beside it | `__tests__/architecture/chatDeletionCleanup.test.ts`; `__tests__/projects/projectStore.test.ts`, `__tests__/projects/chatProjectMigration.test.ts` |
| A chat folder agents cannot use (gone, or outside the allowed folders) is never swapped silently: the chip warns, choosing it is refused, and tools name the folder | `__tests__/projects/projectAccess.test.ts`, `__tests__/frontend/components/ChatProjectChip.test.tsx`, `__tests__/mcp/missingProjectFolder.test.ts` |
| Every place that hands a tool result to a model sizes it with `resolveToolResultBound` (`src/shared/toolResultLimit.ts`), and a shortened result never keeps `structuredContent` (`withBoundedToolText`) | `__tests__/architecture/toolResultBoundSingleRule.test.ts`; `__tests__/model/codexAdapter.test.ts`, `__tests__/model/claudeSubscriptionBuiltinTools.test.ts` |
| FLUJO's own system prompt tells a model only about tools and helpers the step really offers, and each part has a switch that removes it | `planFlujoSystemPromptSections` in `src/shared/utils/flujoSystemPrompt.ts`; `__tests__/flow/flujoSystemPrompt.test.ts`, `__tests__/flow/processNodeSystemSections.test.ts` |
| A file upload limit stays below what FLUJO's request proxy keeps of a body (`proxyClientMaxBodySize` in `next.config.mjs`); a bigger body reaches the route cut off | `MCPB_UPLOAD_CEILING_BYTES` check in `__tests__/mcp/mcpbBundle.test.ts` |
| An MCP bundle is unpacked only after its review, and a zip entry that would land outside its folder refuses the whole bundle | `__tests__/mcp/mcpbBundle.test.ts` |
| A create route never stores a record without an id: a missing id gets a fresh one from `newRecordId` (`src/shared/recordId.ts`), and a model already stored without one gets an id on its next load | `__tests__/architecture/createRouteIds.test.ts` (lists every create route); `__tests__/api/modelCreateId.test.ts` |
| Anthropic Messages requests never send `temperature`, `top_p` or `top_k` (API version 2026-10-21 refuses them on every model); a saved Creativity is kept but not sent. An SDK major that moves to another API version fails until its rules are reviewed | `__tests__/model/anthropicApiVersion20261021.test.ts` (installed SDK, stand-in server with that version's request rules) |
| Resilience over refusal | Prose: needs judgment |
| MCP App settings set where FLUJO starts win over Localhost mode's local default for requests through a front door; this computer keeps `<app>.localhost`, a Settings-page Localhost choice ignores leftovers, and a wrong value falls back with one startup line | `__tests__/mcp/sandboxLocalhostFrontDoor.test.ts` |

# Resilience over refusal

FLUJO is a long-running desktop app. Prefer degrading gracefully to failing
closed:

- Under pressure (busy slots, memory, locks), make callers wait with a bounded
  timeout instead of refusing at once. Retry transient I/O errors.
- A failure must never block a conversation, workspace or slot until restart.
  Every fence, quarantine or counter must be released or healed automatically
  (on the next success, when its owner settles, or when its process is gone).
- Do not add a fixed limit without saying how it recovers without a restart and
  without the user knowing an environment variable. Scale memory limits with
  the machine.
- Keep work off the event loop, and fix the throughput cause (batching, fewer
  syscalls) rather than adding another admission gate.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
