import { watchSteering } from '@/backend/services/model/adapters/liveSteering';
import type { SteeringDelivery } from '@/backend/services/model/adapters/types';

function delivery(): SteeringDelivery {
  return { messages: [{ id: 'correction', role: 'user', content: 'Correct course', timestamp: 1 }],
    beforeSend: jest.fn(async () => undefined), acknowledge: jest.fn(async () => undefined), requeue: jest.fn() };
}

it('does not take input in an unresolved tool exchange and requeues a rejected delivery', async () => {
  let safe = false;
  const batch = delivery();
  const take = jest.fn(async () => batch);
  const onError = jest.fn();
  const unsubscribe = jest.fn();
  const watcher = watchSteering({ source: { take, subscribe: () => unsubscribe }, canDeliver: () => safe,
    deliver: async () => { throw new Error('input rejected'); }, onError });
  await watcher.poll();
  expect(take).not.toHaveBeenCalled();
  safe = true;
  await watcher.poll();
  await watcher.stop();
  expect(batch.requeue).toHaveBeenCalledTimes(1);
  expect(batch.acknowledge).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'input rejected' }));
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('returns a claimed batch if a tool starts while its mailbox is being read', async () => {
  let resolve!: (batch: SteeringDelivery) => void;
  let safe = true;
  const deliver = jest.fn();
  const batch = delivery();
  const watcher = watchSteering({ source: { take: () => new Promise(res => { resolve = res; }), subscribe: () => () => {} }, canDeliver: () => safe, deliver, onError: jest.fn() });
  const pending = watcher.poll();
  safe = false; resolve(batch);
  await pending; await watcher.stop();
  expect(deliver).not.toHaveBeenCalled();
  expect(batch.requeue).toHaveBeenCalledTimes(1);
});

it('does not strand an input claim when the SDK finishes during its mailbox read', async () => {
  let resolve!: (batch: SteeringDelivery) => void;
  const batch = delivery();
  const deliver = jest.fn();
  const watcher = watchSteering({ source: { take: () => new Promise(res => { resolve = res; }), subscribe: () => () => {} }, canDeliver: () => true, deliver, onError: jest.fn() });
  const pending = watcher.poll();
  const stopped = watcher.stop(); resolve(batch);
  await Promise.all([pending, stopped]);
  expect(deliver).not.toHaveBeenCalled();
  expect(batch.requeue).toHaveBeenCalledTimes(1);
});
