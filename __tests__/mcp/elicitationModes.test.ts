import type { MCPServerConfig } from '@/shared/types/mcp';
import {
  registerPendingElicitation,
  resolveConversationElicitation,
  completeServerUrlElicitation,
  listPendingElicitations,
  listAllPendingElicitations,
  clearAllElicitations,
  InvalidElicitationResponseError,
} from '@/backend/services/mcp/elicitationRegistry';
import { completeRequiredUrlElicitations, createElicitationCompleteHandler } from '@/backend/services/mcp/elicitation';
import { clearElicitationContext, setElicitationContext } from '@/backend/services/mcp/elicitationContext';

const emit = jest.fn();
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { emitterFor: () => emit },
}));

const link = (conversationId: string, serverElicitationId?: string) => ({
  conversationId, mode: 'url' as const, message: 'Connect your account', serverName: 'links',
  url: 'https://accounts.example.com/connect', ...(serverElicitationId ? { serverElicitationId } : {}),
});

afterEach(() => {
  clearAllElicitations();
  clearElicitationContext('links');
  emit.mockClear();
});

it('keeps a link request with its server and answers accept with no content', async () => {
  const pending = registerPendingElicitation('url-1', undefined, link('conv-1'));
  expect(listPendingElicitations('conv-1')).toEqual([expect.objectContaining({
    elicitationId: 'url-1', mode: 'url', url: 'https://accounts.example.com/connect', serverName: 'links',
  })]);
  expect(listAllPendingElicitations()).toEqual([expect.objectContaining({
    conversationId: 'conv-1', elicitationId: 'url-1', mode: 'url', serverName: 'links',
  })]);
  expect(() => resolveConversationElicitation('conv-1', 'url-1', { action: 'accept', content: { x: 1 } }))
    .toThrow(InvalidElicitationResponseError);
  expect(resolveConversationElicitation('conv-1', 'url-1', { action: 'accept' })).toBe(true);
  await expect(pending).resolves.toEqual({ action: 'accept' });
});

it('refuses to store a link FLUJO cannot offer safely', () => {
  expect(() => registerPendingElicitation('url-bad', undefined, { ...link('conv-1'), url: 'http://example.com' }))
    .toThrow(/cannot offer safely/);
  expect(listPendingElicitations('conv-1')).toEqual([]);
});

it('records decline separately from cancel for forms', async () => {
  const pending = registerPendingElicitation('form-1', undefined, {
    conversationId: 'conv-2', message: 'Name', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
  });
  expect(listPendingElicitations('conv-2')[0]).toMatchObject({ mode: 'form' });
  expect(resolveConversationElicitation('conv-2', 'form-1', { action: 'decline' })).toBe(true);
  await expect(pending).resolves.toEqual({ action: 'decline' });
  expect(emit).toHaveBeenCalledWith({ type: 'run:elicitation_resolved', elicitationId: 'form-1', action: 'decline' });
});

it('finishes a link when the server sends notifications/elicitation/complete, and ignores unknown ids', async () => {
  const pending = registerPendingElicitation('url-2', undefined, link('conv-3', 'server-id-9'));
  createElicitationCompleteHandler('links')({ params: { elicitationId: 'unknown' } });
  createElicitationCompleteHandler('other-server')({ params: { elicitationId: 'server-id-9' } });
  expect(listPendingElicitations('conv-3')).toHaveLength(1);
  expect(completeServerUrlElicitation('links', 'server-id-9')).toBe(true);
  await expect(pending).resolves.toEqual({ action: 'accept' });
  expect(completeServerUrlElicitation('links', 'server-id-9')).toBe(false);
});

it('asks for every link a -32042 error names before the tool call is tried again', async () => {
  const config = { name: 'links', transport: 'streamable' } as MCPServerConfig;
  setElicitationContext('links', { conversationId: 'conv-4', getUnattended: () => true });
  const links = [
    { serverElicitationId: 'a', url: 'https://one.example.com/a', message: 'First' },
    { serverElicitationId: 'b', url: 'https://two.example.com/b', message: 'Second' },
  ];
  const done = completeRequiredUrlElicitations(config, links);
  for (let turn = 0; turn < 20 && listPendingElicitations('conv-4').length === 0; turn += 1) await Promise.resolve();
  const [first] = listPendingElicitations('conv-4');
  expect(first).toMatchObject({ mode: 'url', url: 'https://one.example.com/a' });
  expect(completeServerUrlElicitation('links', 'a')).toBe(true);
  for (let turn = 0; turn < 20 && listPendingElicitations('conv-4').length === 0; turn += 1) await Promise.resolve();
  const [second] = listPendingElicitations('conv-4');
  expect(second).toMatchObject({ url: 'https://two.example.com/b' });
  expect(resolveConversationElicitation('conv-4', second.elicitationId, { action: 'accept' })).toBe(true);
  await expect(done).resolves.toBe(true);
});

it('stops asking and does not retry when the person declines a required link', async () => {
  const config = { name: 'links', transport: 'streamable' } as MCPServerConfig;
  setElicitationContext('links', { conversationId: 'conv-5', getUnattended: () => false });
  const done = completeRequiredUrlElicitations(config, [
    { serverElicitationId: 'a', url: 'https://one.example.com/a', message: 'First' },
    { serverElicitationId: 'b', url: 'https://two.example.com/b', message: 'Second' },
  ]);
  for (let turn = 0; turn < 20 && listPendingElicitations('conv-5').length === 0; turn += 1) await Promise.resolve();
  const [first] = listPendingElicitations('conv-5');
  resolveConversationElicitation('conv-5', first.elicitationId, { action: 'decline' });
  await expect(done).resolves.toBe(false);
  expect(listPendingElicitations('conv-5')).toEqual([]);
  expect(await completeRequiredUrlElicitations({ ...config, elicitation: { enabled: false } } as MCPServerConfig, [
    { serverElicitationId: 'c', url: 'https://one.example.com/c', message: 'Off' },
  ])).toBe(false);
});
