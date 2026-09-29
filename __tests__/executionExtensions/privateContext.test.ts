import {
  applyExecutionRunInput,
  assertExecutionExtensionCurrent,
  bindExecutionExtensionRun,
  executionToolRequestMeta,
  registerExecutionExtension,
  runWithExecutionInput,
  type ExecutionExtensionContext,
} from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';

describe('private execution authority provenance and overlapping turns', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test('public, cloned, and deserialized objects cannot become run authority', async () => {
    const adapter = fixtureAdapter();
    restore = registerExecutionExtension(adapter);
    const run = fixtureRun();
    const context = mintFixture(adapter, run);
    expect(JSON.stringify(context)).toBe('{}');
    for (const forged of [run, {}, { subject: 'A' }, structuredClone(context), JSON.parse(JSON.stringify(context))]) {
      await expect(assertExecutionExtensionCurrent(forged as ExecutionExtensionContext))
        .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    }
    await expect(assertExecutionExtensionCurrent(context, { conversationId: run.conversation })).resolves.toBeUndefined();
    await expect(bindExecutionExtensionRun(context, 'conversation-B', run.runId))
      .rejects.toMatchObject({ code: 'fixture_authorization_denied' });
  });

  test('changing the registered trusted adapter invalidates old capabilities', async () => {
    const original = fixtureAdapter();
    restore = registerExecutionExtension(original);
    const context = mintFixture(original);
    const restoreReplacement = registerExecutionExtension(fixtureAdapter());
    try {
      await expect(assertExecutionExtensionCurrent(context)).rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    } finally { restoreReplacement(); }
  });

  test.each([1, 10, 50, 500])('%i distinct overlapping private inputs keep one shared graph and separate authority', async count => {
    const adapter = fixtureAdapter();
    restore = registerExecutionExtension(adapter);
    const graph = { id: 'shared-graph', name: 'Shared', nodes: [], edges: [] };
    const seen = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const run = fixtureRun(`subject-${index}`);
      const context = mintFixture(adapter, run);
      return runWithExecutionInput({ conversationId: run.conversation, executionExtensionContext: context }, async () => {
        await new Promise<void>(resolve => setTimeout(resolve, index % 4));
        const input = applyExecutionRunInput({ source: 'api', flowDefinition: graph, conversationId: 'forged-conversation' });
        expect(input.conversationId).toBe(run.conversation);
        expect(input.flowDefinition).toBe(graph);
        await assertExecutionExtensionCurrent(input.executionExtensionContext, { conversationId: run.conversation });
        const meta = await executionToolRequestMeta(input.executionExtensionContext!, 'protected-fixture', 'read', {});
        expect(meta).toEqual({ privateFixture: run.privateMarker });
        expect(JSON.stringify(input.flowDefinition)).not.toContain('PRIVATE-');
        return input.conversationId;
      });
    }));
    expect(new Set(seen).size).toBe(count);
    expect(applyExecutionRunInput({ source: 'api', conversationId: 'ordinary' }).conversationId).toBe('ordinary');
  });

  test('queued work rechecks expiry and revocation before signing', async () => {
    const requestMeta = jest.fn(async () => ({}));
    const adapter = fixtureAdapter({ requestMeta });
    restore = registerExecutionExtension(adapter);
    for (const mutation of ['revoked', 'expired']) {
      const run = fixtureRun();
      const context = mintFixture(adapter, run);
      await assertExecutionExtensionCurrent(context);
      if (mutation === 'revoked') run.revoked = true; else run.expires = Date.now() - 1;
      await expect(executionToolRequestMeta(context, 'protected-fixture', 'read', {}))
        .rejects.toMatchObject({ code: 'fixture_authorization_denied' });
    }
    expect(requestMeta).not.toHaveBeenCalled();
  });
});
