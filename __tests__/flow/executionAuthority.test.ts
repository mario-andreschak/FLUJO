import {
  commitFlowDurableMutation,
  FlowExecutionAuthorityError,
} from '@/backend/execution/flow/executionAuthority';

describe('durable Flow mutation authority', () => {
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
});
