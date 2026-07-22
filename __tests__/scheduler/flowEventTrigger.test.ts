/**
 * Tests for the flow-event trigger (issue #116): armFlowEvent subscribes to the
 * process-global bus and fires only on a matching source + status + optional
 * output filter, honours the cooldown, records a `skipped` run (never fires)
 * once the event-chain depth cap is reached, increments chainDepth on the
 * fired payload, and unsubscribes on dispose.
 */
import { armFlowEvent } from '@/backend/services/scheduler/triggers/flowEvent';
import { getFlowRunEventBus, FlowRunEvent, FlowSignalEvent } from '@/backend/services/scheduler/flowRunEventBus';
import type { FlowEventTriggerConfig } from '@/shared/types/plannedExecution';

const publish = (overrides: Partial<FlowRunEvent> = {}) =>
  getFlowRunEventBus().publish({
    flowId: 'flow-A',
    flowName: 'Flow A',
    executionId: 'exec-A',
    runId: 'run-1',
    conversationId: 'conv-1',
    status: 'completed',
    firedBy: 'schedule',
    chainDepth: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  });

const makeDeps = () => ({
  onFire: jest.fn(),
  onSkip: jest.fn(),
  onError: jest.fn(),
});

beforeEach(() => {
  // Fresh global bus per test so subscribers never leak across cases.
  (global as unknown as { __flujo_flow_run_event_bus?: unknown }).__flujo_flow_run_event_bus =
    undefined;
});

describe('armFlowEvent', () => {
  it('fires on a matching flowId + status, passing the upstream context and depth+1', () => {
    const config: FlowEventTriggerConfig = {
      type: 'flow-event',
      source: { flowId: 'flow-A' },
      on: ['completed'],
    };
    const deps = makeDeps();
    const trigger = armFlowEvent(config, deps);

    publish({ chainDepth: 2, outputText: 'hello world', conversationId: 'conv-up' });

    expect(deps.onFire).toHaveBeenCalledTimes(1);
    const payload = deps.onFire.mock.calls[0][0];
    expect(payload.chainDepth).toBe(3); // upstream 2 → new run 3
    expect(payload.context.flowId).toBe('flow-A');
    expect(payload.context.outputText).toBe('hello world');
    expect(payload.summary).toMatch(/Flow "Flow A" completed/);
    // Runtime lineage (#214): the upstream run's conversation is threaded out so
    // the scheduler can record it as the produced run's parent.
    expect(payload.sourceConversationId).toBe('conv-up');

    trigger.dispose();
  });

  it('ignores non-matching sources and non-selected statuses', () => {
    const config: FlowEventTriggerConfig = {
      type: 'flow-event',
      source: { flowId: 'flow-A' },
      on: ['error'],
    };
    const deps = makeDeps();
    const trigger = armFlowEvent(config, deps);

    publish({ flowId: 'flow-OTHER', status: 'error' }); // wrong source
    publish({ flowId: 'flow-A', status: 'completed' }); // wrong status
    expect(deps.onFire).not.toHaveBeenCalled();

    publish({ flowId: 'flow-A', status: 'error' }); // matches
    expect(deps.onFire).toHaveBeenCalledTimes(1);

    trigger.dispose();
  });

  it('matches by executionId and by flowName', () => {
    const byExec = makeDeps();
    const t1 = armFlowEvent(
      { type: 'flow-event', source: { executionId: 'exec-A' }, on: ['completed'] },
      byExec
    );
    publish({ executionId: 'exec-A' });
    publish({ executionId: 'exec-B' });
    expect(byExec.onFire).toHaveBeenCalledTimes(1);
    t1.dispose();

    (global as unknown as { __flujo_flow_run_event_bus?: unknown }).__flujo_flow_run_event_bus =
      undefined;

    const byName = makeDeps();
    const t2 = armFlowEvent(
      { type: 'flow-event', source: { flowName: 'Flow A' }, on: ['completed'] },
      byName
    );
    publish({ flowName: 'Flow A' });
    publish({ flowName: 'Different' });
    expect(byName.onFire).toHaveBeenCalledTimes(1);
    t2.dispose();
  });

  it('applies the outputMatch contains + regex filter', () => {
    const contains = makeDeps();
    const t1 = armFlowEvent(
      {
        type: 'flow-event',
        source: { flowId: 'flow-A' },
        on: ['completed'],
        outputMatch: { contains: 'FAILED' },
      },
      contains
    );
    publish({ outputText: 'all good' });
    expect(contains.onFire).not.toHaveBeenCalled();
    publish({ outputText: 'step FAILED here' });
    expect(contains.onFire).toHaveBeenCalledTimes(1);
    t1.dispose();

    (global as unknown as { __flujo_flow_run_event_bus?: unknown }).__flujo_flow_run_event_bus =
      undefined;

    const regex = makeDeps();
    const t2 = armFlowEvent(
      {
        type: 'flow-event',
        source: { flowId: 'flow-A' },
        on: ['completed'],
        outputMatch: { regex: '\\berror-\\d+\\b' },
      },
      regex
    );
    publish({ outputText: 'no codes' });
    expect(regex.onFire).not.toHaveBeenCalled();
    publish({ outputText: 'saw error-42 today' });
    expect(regex.onFire).toHaveBeenCalledTimes(1);
    t2.dispose();
  });

  it('surfaces an invalid regex as a trigger error and never fires', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent(
      {
        type: 'flow-event',
        source: { flowId: 'flow-A' },
        on: ['completed'],
        outputMatch: { regex: '(' }, // unbalanced
      },
      deps
    );
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('Invalid output-match regex'));
    publish({ outputText: 'anything' });
    expect(deps.onFire).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it('records a skipped run (never fires) once the chain depth cap is reached', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent(
      { type: 'flow-event', source: { flowId: 'flow-A' }, on: ['completed'], maxChainDepth: 3 },
      deps
    );

    publish({ chainDepth: 2 }); // 2 < 3 → fires (new run would be depth 3)
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    expect(deps.onSkip).not.toHaveBeenCalled();

    publish({ chainDepth: 3 }); // at the cap → skip, no fire
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    expect(deps.onSkip).toHaveBeenCalledTimes(1);
    expect(deps.onSkip.mock.calls[0][0]).toMatch(/depth limit \(3\)/);

    trigger.dispose();
  });

  it('enforces the minIntervalMs cooldown between fires', () => {
    jest.useFakeTimers();
    try {
      const deps = makeDeps();
      const trigger = armFlowEvent(
        {
          type: 'flow-event',
          source: { flowId: 'flow-A' },
          on: ['completed'],
          minIntervalMs: 10_000,
        },
        deps
      );

      publish();
      expect(deps.onFire).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5_000);
      publish(); // still within cooldown → suppressed
      expect(deps.onFire).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(6_000); // now > 10s since first fire
      publish();
      expect(deps.onFire).toHaveBeenCalledTimes(2);

      trigger.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops firing after dispose', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent(
      { type: 'flow-event', source: { flowId: 'flow-A' }, on: ['completed'] },
      deps
    );
    trigger.dispose();
    publish();
    expect(deps.onFire).not.toHaveBeenCalled();
    expect(trigger.nextRun && trigger.nextRun()).toBeNull();
  });
});

const publishSignal = (overrides: Partial<FlowSignalEvent> = {}) =>
  getFlowRunEventBus().publish({
    kind: 'signal',
    topic: 'review-blocked',
    payload: 'blocked',
    emitterFlowId: 'flow-A',
    flowName: 'Flow A',
    runId: 'run-1',
    conversationId: 'conv-1',
    firedBy: 'chat',
    chainDepth: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  });

describe('armFlowEvent topic source (issue #117)', () => {
  it('fires on a matching signal topic, passing the payload context and depth+1', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent({ type: 'flow-event', source: { topic: 'review-blocked' } }, deps);

    publishSignal({ chainDepth: 1, payload: 'boom', conversationId: 'conv-sig' });

    expect(deps.onFire).toHaveBeenCalledTimes(1);
    const payload = deps.onFire.mock.calls[0][0];
    expect(payload.chainDepth).toBe(2); // upstream 1 → new run 2
    expect(payload.context.topic).toBe('review-blocked');
    expect(payload.context.payload).toBe('boom');
    expect(payload.context.emitterFlowId).toBe('flow-A');
    expect(payload.summary).toMatch(/Signal "review-blocked"/);
    // Runtime lineage (#214): the emitting run's conversation is threaded out.
    expect(payload.sourceConversationId).toBe('conv-sig');

    trigger.dispose();
  });

  it('ignores other topics and terminal-run events', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent({ type: 'flow-event', source: { topic: 'wanted' } }, deps);

    publishSignal({ topic: 'other' }); // wrong topic
    publish(); // a completion run event — a topic trigger must ignore it
    expect(deps.onFire).not.toHaveBeenCalled();

    publishSignal({ topic: 'wanted' });
    expect(deps.onFire).toHaveBeenCalledTimes(1);

    trigger.dispose();
  });

  it('a flow/execution trigger ignores signal events', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent(
      { type: 'flow-event', source: { flowId: 'flow-A' }, on: ['completed'] },
      deps
    );
    // Same emitter flow, but a SIGNAL — not a completion. Must not fire.
    publishSignal({ emitterFlowId: 'flow-A' });
    expect(deps.onFire).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it('records a skipped run once a signal chain reaches the depth cap', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent(
      { type: 'flow-event', source: { topic: 't' }, maxChainDepth: 2 },
      deps
    );
    publishSignal({ topic: 't', chainDepth: 1 }); // 1 < 2 → fires
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    publishSignal({ topic: 't', chainDepth: 2 }); // at the cap → skip
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    expect(deps.onSkip).toHaveBeenCalledTimes(1);
    trigger.dispose();
  });

  it('applies the payload outputMatch filter for a topic source', () => {
    const deps = makeDeps();
    const trigger = armFlowEvent(
      { type: 'flow-event', source: { topic: 't' }, outputMatch: { contains: 'FAIL' } },
      deps
    );
    publishSignal({ topic: 't', payload: 'all good' });
    expect(deps.onFire).not.toHaveBeenCalled();
    publishSignal({ topic: 't', payload: 'it FAILed' });
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    trigger.dispose();
  });
});
