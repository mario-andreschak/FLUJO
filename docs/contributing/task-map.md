# Newcomer map

Where things live in FLUJO, what to read first, and the fastest test for each
area. Paths and commands were checked on November 25, 2026 (version 3.48.10). If
one has moved, please fix this page.

## Read first

| Page | What it tells you |
| --- | --- |
| [`AGENTS.md`](../../AGENTS.md) | House rules for people and AI agents, and the checks that enforce them |
| [Architecture](../architecture/README.md) | How the app, the engine and MCP servers fit together, plus decision records |
| [Feature map](../feature-map/README.md) | Every page: what a user can do there and how to reach it |
| [Execution and MCP ownership](../architecture/execution-module-boundaries.md) | Which file owns what inside the flow engine and MCP code |
| [Project status](../project-status.md) | What is stable, what is experimental, and known limits |
| [API reference](../api-reference/README.md) | The HTTP endpoints |

## Where the code lives

| Folder | What is there |
| --- | --- |
| `src/app` | Pages and HTTP routes (Next.js App Router). `src/app/api` is the app's own API, `src/app/v1` the OpenAI-compatible API, `src/app/mcp-proxy` the MCP proxy |
| `src/frontend` | React components, hooks, contexts, browser-side services and translations (`src/frontend/i18n`) |
| `src/backend` | The flow engine (`src/backend/execution/flow`) and services: MCP, models, workspaces, schedules, Personas (`enduringAgents`) and more |
| `src/shared` | Types used by both frontend and backend |
| `src/utils` | Shared helpers: workspace paths, encryption, storage, logging |
| `mcp-servers` | The four built-in MCP servers (bash, browser, filesystem, flujo) and their shared code; `npm run build:mcp` builds them |
| `tooling/eslint-plugin-flujo` | FLUJO's own lint rules |
| `scripts` | Developer, test and release tools |
| `__tests__` | Jest tests, in folders named after the area they test |
| `e2e`, `tests` | Browser journeys (Playwright) and installer tests, mostly run by maintainers and CI |
| `docs` | Documentation; `githubpages` is the public website (changes need the maintainer) |

The import boundary test (`__tests__/architecture/importBoundaries.test.ts`)
stops `backend`, `frontend` and `shared` from importing what their layer may not.

## I want to change…

| Area | Start in | Fastest test |
| --- | --- | --- |
| A page or component | `src/frontend/components/<Area>`, page in `src/app/<route>` | The matching file in `__tests__/frontend/components/` |
| Timers in the UI | `src/frontend/hooks/timing.ts` (the only place UI code may start timers) | The component's test with Jest fake timers |
| Translations | `src/frontend/i18n/catalogs/` | `__tests__/frontend` tests for the component |
| HTTP routes and workspaces | `src/app/api`, `src/app/v1`, `src/proxy.ts`, `src/utils/workspace.ts` | `__tests__/workspace/routeCoverage.test.ts`, `__tests__/workspace/pathSafety.test.ts` |
| Running a flow, conversation history | `src/backend/execution/flow/runFlow.ts`, `FlowExecutor.ts`, `conversationLog.ts` | `__tests__/chat/runFlow.test.ts`, `__tests__/flow/conversationLog.test.ts` |
| Calling an AI model | `src/backend/execution/flow/handlers/ModelHandler.ts`, `src/backend/services/model/adapters` | Files in `__tests__/model` |
| MCP connections and tool calls | `src/backend/services/mcp/connection.ts`, `lifecycleCoordinator.ts`, `src/backend/execution/flow/handlers/MCPHandler.ts` | Files in `__tests__/mcp` |
| The built-in MCP servers | `mcp-servers/<name>` | `npm run build:mcp`, then `npm run test:mcp-process-boundary` |
| Backup and restore | `src/backend/services/workspace/snapshotArchive.ts`, `snapshotRestore.ts`, `backupRestoreFs.ts` | The recovery recipe below |
| Stored credentials | `src/utils/encryption`, `src/utils/storage` | Ask in the issue first; these have migration rules |
| Personas and schedules | `src/backend/services/enduringAgents`, `src/backend/services/scheduler` | Files in `__tests__/enduringAgents`; some are slow, pick the one for your change |
| Lint rules | `tooling/eslint-plugin-flujo/rules` | `npm run test:checks` |
| Releases | `scripts/release*.mjs`, `.github/workflows` | `node --test scripts/release-verification.test.mjs scripts/require-release-verification.test.mjs` |
| This guide | `CONTRIBUTING.md`, `docs/contributing` | Follow the steps; `node --test scripts/maintainer-drill.test.mjs` |

Mario reviews every area himself today. The areas he must approve are listed in
`.github/CODEOWNERS`. Credentials, login, MCP process launch, install and
release code need extra care: ask in the issue before you start there.

## Test recipes

One test file, `.ts` or `.tsx` (the runner picks the right environment):

```sh
node scripts/run-local-jest.cjs __tests__/workspace/pathSafety.test.ts --runInBand
```

Several files at once, using two worker processes:

```sh
node scripts/run-local-jest.cjs __tests__/frontend/components/PersonaGoalCard.test.tsx __tests__/scripts/localTestDependencies.test.ts --maxWorkers=2
```

Script tests that use Node's own test runner:

```sh
node --test scripts/maintainer-drill.test.mjs
```

The four backup and restore suites (synthetic files only, about two minutes):

```sh
node scripts/run-local-jest.cjs __tests__/settings/backupRestoreLinkSafety.test.ts __tests__/settings/backupRestoreRoutes.test.ts __tests__/workspace/snapshotArchive.test.ts __tests__/workspace/snapshotRestore.test.ts --runInBand
```

Good to know:

- Always go through `scripts/run-local-jest.cjs`, not `npx jest`. It checks your
  Node.js and install first and refuses to report success when no test ran.
- Pass test file paths as plain arguments. Quoted glob patterns behave
  differently in PowerShell, cmd.exe and bash.
- Do not run the whole suite (`npm test`, about 1,270 files) on a laptop. CI does.
- Tests that create a workspace need `npm run build:mcp` once after `npm ci`.
- Times measured on November 25, 2026, including start-up: `pathSafety.test.ts`
  about 40 seconds, `PersonaGoalCard.test.tsx` about 30 seconds, the two-file
  example 20 seconds, the four recovery suites 100 seconds.

To check a change in the running app the way a user would, see the
`verify-flujo` skill (`.claude/skills/verify-flujo/SKILL.md`) and the
[feature map](../feature-map/README.md).
