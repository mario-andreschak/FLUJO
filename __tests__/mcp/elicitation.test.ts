import type { MCPServerConfig } from '@/shared/types/mcp';
import { isUnattendedFlowInvocation } from '@/backend/execution/flow/types';
import { createElicitationHandler } from '@/backend/services/mcp/elicitation';
import {
  clearElicitationContext,
  setElicitationContext,
} from '@/backend/services/mcp/elicitationContext';
import { registerPendingElicitation } from '@/backend/services/mcp/elicitationRegistry';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

jest.mock('@/backend/services/mcp/elicitationRegistry', () => ({
  registerPendingElicitation: jest.fn(async () => ({
    action: 'accept',
    content: { answer: 'ok' },
  })),
}));

jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: {
    emitterFor: jest.fn(() => jest.fn()),
  },
}));

const config = {
  name: 'elicitation-test-server',
  elicitation: { enabled: true },
} as unknown as MCPServerConfig;

const registerPendingElicitationMock = registerPendingElicitation as unknown as jest.Mock;
const emitterForMock = executionEventBus.emitterFor as unknown as jest.Mock;

afterEach(() => {
  clearElicitationContext(config.name);
  jest.clearAllMocks();
});

describe('MCP elicitation invocation context (#339)', () => {
  it.each(['schedule', 'trigger', 'subflow', 'mcp', 'internal'] as const)(
    'auto-cancels for derived unattended %s runs',
    async (source) => {
      setElicitationContext(config.name, {
        conversationId: `conv-${source}`,
        getUnattended: () => isUnattendedFlowInvocation(source),
      });

      const result = await createElicitationHandler(config)({ params: { mode: 'form' } });

      expect(result).toEqual({ action: 'cancel' });
      expect(registerPendingElicitationMock).not.toHaveBeenCalled();
      expect(emitterForMock).not.toHaveBeenCalled();
    },
  );

  it('keeps chat elicitation interactive', async () => {
    setElicitationContext(config.name, {
      conversationId: 'conv-chat',
      getUnattended: () => isUnattendedFlowInvocation('chat'),
    });

    const result = await createElicitationHandler(config)({
      params: {
        mode: 'form',
        message: 'Pick one',
        requestedSchema: { type: 'object', properties: {} },
      },
    });

    expect(result).toEqual({ action: 'accept', content: { answer: 'ok' } });
    expect(emitterForMock).toHaveBeenCalledWith('conv-chat');
    expect(registerPendingElicitationMock).toHaveBeenCalledTimes(1);
  });
});
