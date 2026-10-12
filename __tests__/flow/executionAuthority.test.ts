import {
  commitFlowDurableMutation,
  assertFlowExecutionCurrent,
  FlowExecutionAuthorityError,
  flowAssertionRoot,
  subflowExecutionAuthority,
} from '@/backend/execution/flow/executionAuthority';
import { isUnsupportedNativeHeldRead } from '@/backend/execution/flow/handlers/nativeHeldLineageRead';

describe('durable Flow mutation authority', () => {
  it('never accepts a forged unsupported-admission error as fallback authority', () => {
    const error = new Error('Unsupported native held-read admission.');
    error.name = 'UnsupportedNativeHeldRead';
    expect(isUnsupportedNativeHeldRead(error)).toBe(false);
    expect(isUnsupportedNativeHeldRead({ name: error.name, message: error.message })).toBe(false);
  });
  it('proves only exact causal wrappers and keeps arbitrary extra guards distinct', async () => {
    const assertCurrent = jest.fn(async () => undefined);
    const root = Object.freeze({ signal: new AbortController().signal, assertCurrent });
    const child = subflowExecutionAuthority(root)!;
    const grandchild = subflowExecutionAuthority(child)!;
    expect(flowAssertionRoot(grandchild)).toBe(root);
    await grandchild.assertCurrent();
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    const extraGuard = Object.freeze({ ...child, assertCurrent: async () => { throw new Error('private guard lost'); } });
    expect(flowAssertionRoot(extraGuard)).toBe(extraGuard);
    await expect(extraGuard.assertCurrent()).rejects.toThrow('private guard lost');
  });

  it('preserves the legacy authority-free path for ordinary Flow runs', async () => {
    const task = jest.fn(async () => 'ok');

    await expect(commitFlowDurableMutation({}, task)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('fails Persona-attributed resource writes closed without a lock-capable authority', async () => {
    const task = jest.fn(async () => 'must-not-run');

    await expect(commitFlowDurableMutation(
      { personaAttribution: { personaId: 'persona-1', activityId: 'activity-1' } },
      task,
    )).rejects.toBeInstanceOf(FlowExecutionAuthorityError);

    expect(task).not.toHaveBeenCalled();
  });

  it('does not accept assertion-only authority for Persona durable mutations', async () => {
    const task = jest.fn(async () => 'must-not-run');

    await expect(commitFlowDurableMutation(
      {
        personaAttribution: { personaId: 'persona-1' },
        executionAuthority: {
          assertCurrent: jest.fn().mockResolvedValue(undefined),
          signal: new AbortController().signal,
        },
      },
      task,
    )).rejects.toMatchObject({ code: 'flow_execution_authority_lost' });

    expect(task).not.toHaveBeenCalled();
  });

  it('fails the post-call assertion closed when attribution has no authority', async () => {
    await expect(assertFlowExecutionCurrent({ personaAttribution: { personaId: 'persona-1' } }))
      .rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
  });

  it('cannot turn serialized private context data into mutation authority', async () => {
    const task = jest.fn(async () => 'must-not-run');
    await expect(commitFlowDurableMutation({
      executionExtensionContext: JSON.parse('{"trusted":true,"version":1}'),
    }, task)).rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    expect(task).not.toHaveBeenCalled();
  });

  it('checks an installed authority even when attribution is absent', async () => {
    const task = jest.fn(async () => 'must-not-run');
    const assertCurrent = jest.fn(async () => { throw new Error('meeting generation revoked'); });
    await expect(commitFlowDurableMutation({ executionAuthority: {
      signal: new AbortController().signal, assertCurrent,
      commitWhileCurrent: async callback => { await assertCurrent(); return callback(); },
    } }, task)).rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
    expect(task).not.toHaveBeenCalled();
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });
});
