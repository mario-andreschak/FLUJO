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
import { _setConversationLogDirForTests } from '@/backend/execution/flow/conversationLog';

_setConversationLogDirForTests(path.join(os.tmpdir(), `flujo-test-convlogs-${process.pid}`));
