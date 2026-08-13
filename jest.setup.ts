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
const inheritedTestDataDir = process.env.FLUJO_DATA_DIR;
const jestDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `flujo-jest-data-${process.pid}-`));
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

afterAll(() => {
  setWorkspaceLayoutPreparation(undefined);
  if (inheritedTestDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = inheritedTestDataDir;
  fs.rmSync(jestDataRoot, { recursive: true, force: true });
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
