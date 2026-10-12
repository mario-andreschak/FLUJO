import { subscribeModernResource, retireModernSubscriptions } from '@/backend/services/mcp/modernSubscriptions';

test('legacy resource subscriptions keep the legacy RPC path', async () => {
  const client = { getProtocolEra: () => 'legacy', listen: jest.fn() };
  expect(await subscribeModernResource(client, 'fixture://one')).toBe(false);
  expect(client.listen).not.toHaveBeenCalled();
});

test('modern resource streams request exact URIs, deduplicate, and close on retirement', async () => {
  let closeStream!: () => void;
  const closed = new Promise<'local'>(resolve => { closeStream = () => resolve('local'); });
  const close = jest.fn(async () => closeStream());
  const listen = jest.fn(async () => ({ honoredFilter: { resourceSubscriptions: ['fixture://one'] }, close, closed }));
  const client = { getProtocolEra: () => 'modern', listen };
  await Promise.all([subscribeModernResource(client, 'fixture://one'), subscribeModernResource(client, 'fixture://one')]);
  expect(listen).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledWith({ resourceSubscriptions: ['fixture://one'] });
  retireModernSubscriptions(client);
  await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
});

test('a pending stream is closed when its retired acknowledgment arrives', async () => {
  let acknowledge!: (subscription: unknown) => void;
  const close = jest.fn().mockResolvedValue(undefined);
  const client = { getProtocolEra: () => 'modern', listen: jest.fn(() => new Promise(resolve => { acknowledge = resolve; })) };
  const pending = subscribeModernResource(client, 'fixture://one');
  retireModernSubscriptions(client);
  acknowledge({ honoredFilter: { resourceSubscriptions: ['fixture://one'] }, close, closed: new Promise(() => {}) });
  await pending;
  expect(close).toHaveBeenCalledTimes(1);
});

test('an unhonored resource filter is retired without broadening the subscription', async () => {
  const close = jest.fn().mockResolvedValue(undefined);
  const client = { getProtocolEra: () => 'modern', listen: jest.fn(async () => ({ honoredFilter: {}, close, closed: new Promise(() => {}) })) };
  await subscribeModernResource(client, 'fixture://one');
  expect(close).toHaveBeenCalledTimes(1);
});
