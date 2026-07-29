/** @jest-environment jsdom */
jest.mock('@/frontend/components/Chat/ChatInput', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/Chat/ChatMessages', () => ({
  __esModule: true,
  default: () => null,
}));

import { extractFlowDraft } from '@/frontend/components/Flow/FlowManager/GenerateFlowDialog';

describe('GenerateFlowDialog draft extraction', () => {
  const draft = {
    rootFlowId: 'root-1',
    flow: { id: 'root-1', name: 'Draft', nodes: [], edges: [] },
    flows: [{ id: 'root-1', name: 'Draft', nodes: [], edges: [] }],
    validation: { errorCount: 0, warningCount: 1 },
  };

  it('reads a direct draft_flow tool result', () => {
    expect(extractFlowDraft([
      { role: 'tool', content: JSON.stringify(draft) },
    ])).toEqual(draft);
  });

  it('unwraps an MCP text-content result and prefers the newest draft', () => {
    const newer = { ...draft, rootFlowId: 'root-2', flow: { ...draft.flow, id: 'root-2' } };
    expect(extractFlowDraft([
      { role: 'tool', content: JSON.stringify(draft) },
      {
        role: 'tool',
        content: JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(newer) }],
        }),
      },
    ])).toEqual(newer);
  });
});
