import {
  createExecutionExtensionContext,
  ExecutionExtensionError,
  type ExecutionExtensionAdapter,
  type ExecutionExtensionContext,
} from '@/backend/execution/extensions';

/** Test policy only. Crypto/session ownership is tested against the banking adapter separately. */
export interface FixtureRun {
  subject: string;
  conversation: string;
  runId: string;
  expires: number;
  revoked: boolean;
  privateMarker: string;
}

export function fixtureRun(subject = 'A'): FixtureRun {
  return { subject, conversation: `conversation-${subject}`, runId: `run-${subject}`,
    expires: Date.now() + 60_000, revoked: false, privateMarker: `PRIVATE-${subject}` };
}

export function fixtureAdapter(overrides: Partial<ExecutionExtensionAdapter> = {}): ExecutionExtensionAdapter {
  const assertRun: ExecutionExtensionAdapter['assertRun'] = async (value, expected) => {
    const run = value as FixtureRun;
    if (run.revoked || run.expires <= Date.now()
      || (expected?.conversationId && expected.conversationId !== run.conversation)
      || (expected?.runId && expected.runId !== run.runId)) {
      throw new ExecutionExtensionError('fixture_authorization_denied');
    }
  };
  return {
    isProtectedServer: server => server === 'protected-fixture',
    assertServerConfig: () => undefined,
    assertRun,
    bindRun: async (value, conversation, runId) => assertRun(value, { conversationId: conversation, runId }),
    signal: () => undefined,
    commit: async (value, task) => { await assertRun(value); const result = await task(); await assertRun(value); return result; },
    protectedServer: () => 'protected-fixture',
    authorizeHandoffs: () => undefined,
    assertModelTool: async (value, _name, advertised) => {
      await assertRun(value);
      if (advertised?.server !== 'protected-fixture') throw new ExecutionExtensionError('fixture_tool_forbidden');
    },
    assertDispatch: async (value, server, source) => {
      if (!value || server !== 'protected-fixture' || !['host', 'model'].includes(source)) {
        throw new ExecutionExtensionError('fixture_authorization_denied');
      }
      await assertRun(value);
    },
    normalizeArguments: (_value, _tool, args) => ({ ...args, limit: args.limit ?? 1 }),
    requestMeta: async value => ({ privateFixture: (value as FixtureRun).privateMarker }),
    validateResult: (_value, _tool, result) => result,
    ...overrides,
  };
}

export function mintFixture(adapter: ExecutionExtensionAdapter, run = fixtureRun()): ExecutionExtensionContext {
  return createExecutionExtensionContext(adapter, run);
}
