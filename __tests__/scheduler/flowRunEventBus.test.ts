/**
 * Tests for the process-global FlowRunEvent bus (issue #116): publish reaches
 * every current subscriber, unsubscribe stops delivery, a throwing listener is
 * isolated from the others, and unsubscribing during a dispatch is safe (the
 * dispatch iterates a snapshot). getFlowRunEventBus() returns the singleton.
 */
import {
  FlowRunEventBus,
  getFlowRunEventBus,
  FlowRunEvent,
} from '@/backend/services/scheduler/flowRunEventBus';

const makeEvent = (overrides: Partial<FlowRunEvent> = {}): FlowRunEvent => ({
  flowId: 'flow-1',
  flowName: 'Flow One',
  runId: 'run-1',
  conversationId: 'conv-1',
  status: 'completed',
  firedBy: 'chat',
  chainDepth: 0,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe('FlowRunEventBus', () => {
  it('delivers a published event to every subscriber', () => {
    const bus = new FlowRunEventBus();
    const a = jest.fn();
    const b = jest.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    const event = makeEvent();
    bus.publish(event);

    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it('stops delivering after unsubscribe (idempotent)', () => {
    const bus = new FlowRunEventBus();
    const listener = jest.fn();
    const unsub = bus.subscribe(listener);

    bus.publish(makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    unsub(); // idempotent — must not throw
    bus.publish(makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount).toBe(0);
  });

  it('isolates a throwing listener from the others', () => {
    const bus = new FlowRunEventBus();
    const boom = jest.fn(() => {
      throw new Error('listener blew up');
    });
    const ok = jest.fn();
    bus.subscribe(boom);
    bus.subscribe(ok);

    expect(() => bus.publish(makeEvent())).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('is safe to unsubscribe during dispatch (snapshot iteration)', () => {
    const bus = new FlowRunEventBus();
    const seen: string[] = [];
    let unsubB: () => void = () => undefined;
    const a = jest.fn(() => {
      seen.push('a');
      unsubB(); // remove b mid-dispatch
    });
    const b = jest.fn(() => seen.push('b'));
    bus.subscribe(a);
    unsubB = bus.subscribe(b);

    // b was still subscribed at publish time → gets this event from the snapshot.
    bus.publish(makeEvent());
    // Next publish: b is gone.
    bus.publish(makeEvent());

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('getFlowRunEventBus returns a stable global singleton', () => {
    const first = getFlowRunEventBus();
    const second = getFlowRunEventBus();
    expect(first).toBe(second);
  });
});
