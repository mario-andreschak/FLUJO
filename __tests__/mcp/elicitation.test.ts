import type { MCPServerConfig } from '@/shared/types/mcp';
import { isUnattendedFlowInvocation } from '@/backend/execution/flow/types';
import {
  createElicitationHandler,
  elicitationCapability,
  requiredUrlElicitationsOf,
} from '@/backend/services/mcp/elicitation';
import {
  clearElicitationContext,
  setElicitationContext,
} from '@/backend/services/mcp/elicitationContext';
import { registerPendingElicitation, URL_ELICITATION_TIMEOUT_MS } from '@/backend/services/mcp/elicitationRegistry';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

jest.mock('@/backend/services/mcp/elicitationRegistry', () => ({
  URL_ELICITATION_TIMEOUT_MS: 600000,
  registerPendingElicitation: jest.fn(async () => ({
    action: 'accept',
    content: { answer: 'ok' },
  })),
  cancelConversationElicitation: jest.fn(),
  completeServerUrlElicitation: jest.fn(),
}));

jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => {
  const emit = jest.fn();
  return { executionEventBus: { emitterFor: jest.fn(() => emit) } };
});

const config = {
  name: 'elicitation-test-server',
  transport: 'streamable',
} as unknown as MCPServerConfig;

const registerPendingElicitationMock = registerPendingElicitation as unknown as jest.Mock;
const emitterForMock = executionEventBus.emitterFor as unknown as jest.Mock;
const emitted = () => (emitterForMock.mock.results[0]?.value as jest.Mock | undefined)?.mock.calls.map(([event]) => event) ?? [];

function attend(conversationId: string, unattended = false): void {
  setElicitationContext(config.name, { conversationId, getUnattended: () => unattended });
}

afterEach(() => {
  clearElicitationContext(config.name);
  jest.clearAllMocks();
});

describe('MCP elicitation is on by default and declares both modes (#1448)', () => {
  it('declares form and url unless the user turned elicitation off', () => {
    expect(elicitationCapability(config)).toEqual({ form: {}, url: {} });
    expect(elicitationCapability({ ...config, elicitation: { enabled: false } } as MCPServerConfig)).toBeUndefined();
    // A local server keeps link mode for its own account sign-in.
    expect(elicitationCapability({ ...config, transport: 'stdio', elicitation: { enabled: false } } as MCPServerConfig))
      .toEqual({ url: {} });
    // A host-trusted server keeps the switches exactly as approved.
    expect(elicitationCapability({ ...config, trustedHost: {} } as MCPServerConfig)).toBeUndefined();
  });

  it('refuses a form the server was never offered, and cancels a link', async () => {
    const off = { ...config, elicitation: { enabled: false } } as MCPServerConfig;
    attend('conv-off');
    await expect(createElicitationHandler(off)({ params: { mode: 'form', message: 'x', requestedSchema: { type: 'object', properties: {} } } }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(createElicitationHandler(off)({ params: { mode: 'url', message: 'x', url: 'https://example.com' } }))
      .resolves.toEqual({ action: 'cancel' });
    expect(registerPendingElicitationMock).not.toHaveBeenCalled();
  });
});

describe('MCP elicitation invocation context (#339, #1448)', () => {
  it.each(['schedule', 'trigger', 'subflow', 'mcp', 'internal'] as const)(
    'waits with a bound in background %s runs instead of cancelling at once',
    async (source) => {
      attend(`conv-${source}`, isUnattendedFlowInvocation(source));

      const result = await createElicitationHandler(config)({
        params: { mode: 'form', message: 'Pick one', requestedSchema: { type: 'object', properties: {} } },
      });

      expect(result).toEqual({ action: 'accept', content: { answer: 'ok' } });
      expect(registerPendingElicitationMock).toHaveBeenCalledWith(expect.any(String), undefined, expect.objectContaining({
        conversationId: `conv-${source}`, mode: 'form', serverName: config.name,
      }));
    },
  );

  it('keeps chat elicitation interactive and names the server', async () => {
    attend('conv-chat');

    const result = await createElicitationHandler(config)({
      params: { message: 'Pick one', requestedSchema: { type: 'object', properties: {} } },
    });

    expect(result).toEqual({ action: 'accept', content: { answer: 'ok' } });
    expect(emitterForMock).toHaveBeenCalledWith('conv-chat');
    expect(emitted()).toContainEqual(expect.objectContaining({
      type: 'run:awaiting_elicitation', mode: 'form', serverName: config.name, message: 'Pick one',
    }));
  });

  it('cancels outside a run, where no conversation can show the request', async () => {
    await expect(createElicitationHandler(config)({ params: { mode: 'form', message: 'x' } }))
      .resolves.toEqual({ action: 'cancel' });
    expect(registerPendingElicitationMock).not.toHaveBeenCalled();
  });
});

describe('URL-mode elicitation (#1448)', () => {
  it('shows a checked https link with the longer wait and the server id', async () => {
    registerPendingElicitationMock.mockResolvedValueOnce({ action: 'accept' });
    attend('conv-url');

    const result = await createElicitationHandler(config)({
      params: { mode: 'url', message: 'Connect your account', url: 'https://accounts.example.com/connect?x=1', elicitationId: 'el-1' },
    });

    expect(result).toEqual({ action: 'accept' });
    expect(registerPendingElicitationMock).toHaveBeenCalledWith(expect.any(String), URL_ELICITATION_TIMEOUT_MS, expect.objectContaining({
      mode: 'url', url: 'https://accounts.example.com/connect?x=1', serverElicitationId: 'el-1', serverName: config.name,
    }));
    expect(emitted()).toContainEqual(expect.objectContaining({
      type: 'run:awaiting_elicitation', mode: 'url', url: 'https://accounts.example.com/connect?x=1',
    }));
  });

  it.each([
    'javascript:alert(1)',
    'http://example.com/plain-http',
    'https://bank.example@evil.example/',
    'file:///etc/passwd',
    '',
  ])('refuses the unsafe link %p with invalid params', async (url) => {
    attend('conv-url');
    await expect(createElicitationHandler(config)({ params: { mode: 'url', message: 'x', url } }))
      .rejects.toMatchObject({ code: -32602 });
    expect(registerPendingElicitationMock).not.toHaveBeenCalled();
  });

  it('refuses a mode it does not know', async () => {
    attend('conv-url');
    await expect(createElicitationHandler(config)({ params: { mode: 'telepathy', message: 'x' } }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('reads URLElicitationRequiredError (-32042) and ignores anything malformed', () => {
    const link = { mode: 'url', elicitationId: 'abc', url: 'https://example.com/auth', message: 'Sign in' };
    expect(requiredUrlElicitationsOf({ code: -32042, data: { elicitations: [link] } }))
      .toEqual([{ serverElicitationId: 'abc', url: 'https://example.com/auth', message: 'Sign in' }]);
    expect(requiredUrlElicitationsOf({ code: -32602, data: { elicitations: [link] } })).toBeUndefined();
    expect(requiredUrlElicitationsOf({ code: -32042, data: { elicitations: [{ ...link, url: 'javascript:x' }] } })).toBeUndefined();
    expect(requiredUrlElicitationsOf({ code: -32042, data: { elicitations: [{ ...link, elicitationId: '' }] } })).toBeUndefined();
    expect(requiredUrlElicitationsOf({ code: -32042, data: { elicitations: Array(5).fill(link) } })).toBeUndefined();
    expect(requiredUrlElicitationsOf(undefined)).toBeUndefined();
  });
});
