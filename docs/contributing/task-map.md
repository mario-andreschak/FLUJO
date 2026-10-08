# Architecture to contributor tasks

Source map checked against `3511ba49514fe8cf525f5a22c16c3806bf3886ba` (3.46.2),
October 3, 2026. Recheck paths and current ownership before each change. This map
describes module responsibilities; it does not claim a trained human backup exists.
Read the [architecture overview](../architecture/README.md) and decision records.

| Area / observable boundary | Entry points | Focused recipe / evidence | Epic owner |
| --- | --- | --- | --- |
| HTTP and workspace context | `src/app/api`, `src/app/v1`, `src/proxy.ts`, `src/utils/workspace.ts` | `__tests__/workspace/routeCoverage.test.ts`, `__tests__/workspace/pathSafety.test.ts` | Security #566; Production #574 |
| Flow execution, cancellation and conversation persistence | `src/backend/execution/flow/runFlow.ts`, `FlowExecutor.ts`, `conversationLog.ts`, `src/shared/types/execution` | `__tests__/chat/runFlow.test.ts`, `__tests__/flow/conversationLog.test.ts` | Code health #571; Maturity #569 |
| MCP connection lifecycle / tool dispatch | `src/backend/services/mcp/connection.ts`, `lifecycleCoordinator.ts`, `src/backend/execution/flow/handlers/MCPHandler.ts` | `__tests__/mcp`; built packages: `npm run test:mcp-process-boundary` | Security #568; Production #547 |
| Standalone MCP distribution | `mcp-servers/{shared,filesystem,bash,browser,flujo}`, `mcp-servers/embed-shared.mjs` | `npm run build:mcp`, `npm run typecheck:mcp`, process-boundary recipe | Engineering #565 |
| Tools UI and first journey | `src/frontend/components/mcp`, `src/frontend/hooks`, `src/frontend/i18n` | `__tests__/frontend`; use the test file matching the changed component | Feature #572; existing #517/#526 |
| Snapshot capture / restore | `src/backend/services/workspace/{snapshotArchive,snapshotRestore,backupRestoreFs}.ts` | Drill's four recovery suites below | Production #570; Maturity #569 limits |
| Credentials and private storage | `src/utils/encryption`, `src/utils/storage` | Select regression suites under `__tests__` after checking the existing migration contract | Security #567 |
| Personas / schedules / ownership | `src/backend/services/enduringAgents`, `src/backend/services/scheduler` | Existing isolated Persona suites; full soaks require coordinator scheduling | Maturity #569; Production #553 |
| Release identity and gates | `scripts/release*.mjs`, `scripts/npm-release.mjs`, `.github/workflows` | `node --test scripts/release-verification.test.mjs scripts/require-release-verification.test.mjs` | Engineering #565 |
| Contributor experience and continuity | `CONTRIBUTING.md`, `docs/contributing`, `scripts/maintainer-drill*` | `node --test scripts/maintainer-drill.test.mjs`; human onboarding observation separately | Community #576 |

Run a listed Jest file directly, avoiding npm/PowerShell argument forwarding:

```sh
node scripts/run-local-jest.cjs --selectProjects node --runInBand '--testMatch=**/__tests__/**/*.test.ts' --runTestsByPath __tests__/workspace/pathSafety.test.ts
```

For a React component's matching suite use `--selectProjects jsdom` instead.
Confirm the actual file and project in `jest.testMatch.mjs`; this map is not a
promise that all tests within an entire directory are a cheap check.

The serial recovery recipe is:

```sh
node scripts/run-local-jest.cjs --selectProjects node --runInBand '--testMatch=**/__tests__/**/*.test.ts' --runTestsByPath __tests__/settings/backupRestoreLinkSafety.test.ts __tests__/settings/backupRestoreRoutes.test.ts __tests__/workspace/snapshotArchive.test.ts __tests__/workspace/snapshotRestore.test.ts
```

These exercise real archive/restore logic with synthetic files and mocked service
boundaries. They do not verify a running installed release, provider credentials,
or permission recovery on a real account. Follow the [drill runbook](maintainer-drill.md)
for exact scope and evidence retention.

Cross-stream changes must preserve dedicated bearer/owner session boundaries,
original versus current identity, request IDs/digests, private snapshot material,
idempotent observations, and startup/COMMIT/transport fences. Ask the epic
coordinator to obtain the current FACTORY/O/brain-online contract before editing
those interfaces. Source fixtures do not authorize controller activation or live
replay. Do not copy private handoff artifacts into a PR.
