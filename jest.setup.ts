// Global test setup (setupFilesAfterEnv).
//
// The ExecutionEventBus taps every emitted event into the append-only
// conversation log on disk. Tests all over the suite emit real bus events for
// states registered in FlowExecutor.conversationStates, so without redirection
// they would write JSONL files into the repo's db/conversation-logs/. Point the
// store at a per-process temp directory instead; suites that assert on the log
// (conversationLog.test.ts) set their own directory on top of this.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { setWorkspaceLayoutPreparation } from '@/backend/services/workspace/layoutReadiness';

jest.setTimeout(15_000);

// Workspace route wrappers now await the real layout barrier. Give every Jest
// environment an isolated installation root before test modules are evaluated,
// so an unmocked route can never migrate or write the checkout's real data.
const jestDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `flujo-jest-data-${process.pid}-`));
// An MCP-launched command may carry the installation parent separately from its
// workspace-scoped FLUJO_DATA_DIR. Jest owns a wholly independent root, so drop
// that inherited boundary marker before test modules resolve application paths.
delete process.env.FLUJO_PARENT_DATA_DIR;
process.env.FLUJO_DATA_DIR = jestDataRoot;
fs.mkdirSync(path.join(jestDataRoot, 'workspaces', 'default-workspace'), { recursive: true });

// Next's instrumentation hook is not executed by direct route-unit imports.
// Model normal completed startup for ordinary tests; migration suites call
// _resetWorkspaceMigrationState() in their own beforeEach and therefore still
// exercise the actual transaction and every failure/recovery checkpoint.
beforeEach(async () => {
  const ready = Promise.resolve();
  setWorkspaceLayoutPreparation(ready);
  await ready;
});

afterAll(async () => {
  // Some suites temporarily replace (or delete) FLUJO_DATA_DIR in afterEach.
  // Reassert the sandbox before any global teardown work can enqueue or resolve
  // another path.
  delete process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_DATA_DIR = jestDataRoot;

  // Statistics writes are intentionally fire-and-forget in production. Keep
  // this environment's isolated data root selected until every queued append
  // has settled; otherwise a late append resolves FLUJO_DATA_DIR after it has
  // been restored and leaks test telemetry into the inherited workspace.
  const { flushStatisticsEvents } = jest.requireActual<
    typeof import('@/backend/services/statistics')
  >('@/backend/services/statistics');
  await flushStatisticsEvents();

  setWorkspaceLayoutPreparation(undefined);
  fs.rmSync(jestDataRoot, { recursive: true, force: true });
  // Deliberately do not restore an inherited FLUJO_DATA_DIR. Jest's next test
  // environment replaces it with another isolated root, and the worker exits
  // after its final environment. Keeping this temp path selected also confines
  // callbacks that outlive the suite instead of letting them reach real data.
  delete process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_DATA_DIR = jestDataRoot;
});

// Load the log after each test module has installed its mocks. Importing it at
// setup evaluation time also loaded persistConversationState too early, binding
// that module to the real storage backend instead of focused test fixtures.
beforeAll(() => {
  const { _setConversationLogDirForTests } = jest.requireActual<
    typeof import('@/backend/execution/flow/conversationLog')
  >('@/backend/execution/flow/conversationLog');
  _setConversationLogDirForTests(path.join(os.tmpdir(), `flujo-test-convlogs-${process.pid}`));
});
