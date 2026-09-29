/** Operator-only: real internal dispatch, ticket service and disk persistence.
 * Unused services and execution locks are isolated; this is not bound-customer
 * authorization, model/provider acceptance, or a production lock/restart test.
 */
jest.mock('@/backend/services/flow', () => ({ flowService: {} }));
jest.mock('@/backend/services/model', () => ({ modelService: {} }));
jest.mock('@/backend/services/scheduler', () => ({ getSchedulerService: jest.fn() }));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: jest.fn() }));
jest.mock('@/backend/services/flow/compileFlow', () => ({ compileSpec: jest.fn() }));
jest.mock('@/backend/services/mcp/flowAuthoringTools', () => ({
  isAuthoringTool: () => false, authoringToolDefinitions: () => [], authoringCallTool: jest.fn(),
}));
jest.mock('@/backend/services/mcp/personaCompositionTools', () => ({
  isPersonaCompositionTool: () => false, personaCompositionToolDefinitions: () => [], callPersonaCompositionTool: jest.fn(),
}));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn() }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  flushConversationLog: jest.fn(), readConversationLog: jest.fn(), projectMessages: jest.fn(),
}));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: {} }));
jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({
  withWorkspaceMutation: async (task: () => Promise<unknown>) => task(),
}));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: async (_id: string, task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) =>
    task({ assertOwned: async () => undefined }),
}));
jest.mock('@/utils/workspace', () => {
  const actual = jest.requireActual('@/utils/workspace');
  return { ...actual,
    getWorkspaceDataDir: () => mockDataRoot,
    workspaceCacheKey: (...keys: string[]) => [mockDataRoot, ...keys].join(':'),
  };
});
jest.mock('@/utils/paths', () => ({
  ...jest.requireActual('@/utils/paths'), getDataDir: () => mockDataRoot,
}));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { internalCallTool, type InternalDispatchService } from '@/backend/services/mcp/internalTools';
import { injectTrustedFlujoToolContext } from '@/backend/services/mcp/trustedToolContext';
import { ticketService, TicketService } from '@/backend/services/ticket';

let mockDataRoot: string;
const source: MCPServerConfig = {
  name: 'operator-ticket-server', transport: 'stdio', command: 'node',
  args: ['mcp-servers/flujo/dist/index.js'],
  source: { type: 'marketplace', id: '@mario.andreschak/mcp-flujo' },
} as MCPServerConfig;
const conversation = `slack-${'a'.repeat(48)}`;
const flow = 'banking-operator-graph';
const facts = {
  transaction_reference: 'txn_012345abcdef', transaction_date: '2026-06-02T12:00:00', process_date: '2026-06-02',
  amount: '120.40', currency: 'MXN', status: 'Pending', merchant: null,
  transaction_type: 'Purchase', channel: 'POS', product: 'Credit Card',
};
const message = JSON.stringify({
  schema: 'banking-local-handoff/v1', local_only: true, language: 'es', reason: 'requested_human',
  customer_request: 'Quiero hablar con una persona', verified_facts: facts,
  evidence: { tool: 'get_my_transaction', snapshot: 'synthetic-fixture', freshness: 'derived_snapshot' },
  actions_taken: ['read_only_transaction_lookup'], unresolved_questions: ['¿Reconoce el cargo?'],
  bank_action_taken: false, dispute_submitted: false,
  next_step: 'Local human review; no bank decision or response deadline promised.',
});
const service = {} as InternalDispatchService; // This tool dispatch does not invoke MCP/flow-management methods.
const receipt = (result: Awaited<ReturnType<typeof internalCallTool>>) => {
  const block = result.content.find(item => item.type === 'text');
  return JSON.parse((block as { text: string }).text) as { created?: boolean; id?: string; error?: string };
};

beforeEach(async () => {
  mockDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-operator-handoff-'));
});
afterEach(async () => {
  // Check the resolved path before recursive Windows cleanup; never touch a runtime workspace.
  const resolved = path.resolve(mockDataRoot);
  expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(resolved)).toMatch(/^flujo-operator-handoff-/);
  await fs.rm(resolved, { recursive: true, force: true });
});

describe('operator local human handoff dispatch and persisted readback', () => {
  it('stores actual tool dispatch output and rereads it through a fresh service instance', async () => {
    const args = injectTrustedFlujoToolContext(source, 'create_ticket_for_human', {
      message, title: 'Banking inquiry: local human review', labels: 'banking,local-handoff,es',
      conversation_id: 'forged-B', flow_id: flow,
    }, 'model', { conversationId: conversation });
    const result = await internalCallTool(service, 'create_ticket_for_human', args, 'model');
    expect(result.isError).not.toBe(true);
    const created = receipt(result);
    expect(created.created).toBe(true);
    expect(created.id).toMatch(/^[A-Za-z0-9_-]+$/);
    const stored = await new TicketService().getTicket(created.id!);
    expect(stored).toMatchObject({ id: created.id, message, conversationId: conversation, flowId: flow,
      status: 'open', source: 'agent', labels: ['banking', 'local-handoff', 'es'] });
    const bytes = await fs.readFile(path.join(mockDataRoot, 'db', 'tickets', `${created.id}.json`), 'utf8');
    expect(JSON.parse(bytes)).toEqual(stored);
    expect(JSON.parse(stored!.message).verified_facts).toEqual(facts);
    expect(JSON.parse(stored!.message).dispute_submitted).toBe(false);
    // This last comparison is a host oracle over observed bank facts, not model self-verification.
  });

  it('returns no created receipt for invalid or unwritable ticket input', async () => {
    const invalid = await internalCallTool(service, 'create_ticket_for_human', { message: 'x'.repeat(4001) }, 'model');
    expect(invalid.isError).toBe(true);
    expect(receipt(invalid).created).toBeUndefined();
    expect((await ticketService.listTickets()).total).toBe(0);
    await fs.mkdir(path.join(mockDataRoot, 'db'), { recursive: true });
    await fs.writeFile(path.join(mockDataRoot, 'db', 'tickets'), 'blocked-path');
    const failed = await internalCallTool(service, 'create_ticket_for_human', { message, conversation_id: conversation }, 'model');
    expect(failed.isError).toBe(true);
    expect(receipt(failed).created).toBeUndefined();
  });

  it('does not pretend existing local ticket creation is idempotent', async () => {
    const args = { message, conversation_id: conversation, flow_id: flow };
    const first = receipt(await internalCallTool(service, 'create_ticket_for_human', args, 'model'));
    const second = receipt(await internalCallTool(service, 'create_ticket_for_human', args, 'model'));
    expect(first.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect((await ticketService.listTickets()).total).toBe(2);
    // Therefore the demo must not automatically retry uncertain ticket writes.
  });
});
