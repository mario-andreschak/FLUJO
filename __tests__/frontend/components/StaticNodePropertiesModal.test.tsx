import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { FlowNode } from '@/frontend/types/flow/flow';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo, useAskFlujoPage: mockUseAskFlujoPage,
}));
jest.mock('@/frontend/hooks/useServerStatus', () => ({
  useServerStatus: () => ({ servers: [], isLoading: false, loadError: null }),
}));
jest.mock('@/frontend/hooks/useServerTools', () => ({
  useServerTools: () => ({ tools: [], isLoading: false, error: null }),
}));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: {
  listServerTools: jest.fn(async () => ({ tools: [] })),
} }));

import StaticNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/StaticNodePropertiesModal';

const fixture = (): FlowNode => ({
  id: 'static', type: 'static', position: { x: 0, y: 0 },
  data: { type: 'static', label: 'Probe', properties: {
    entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'bash', toolName: 'run',
      argumentsJson: '{}', result: '', captureVariable: 'health', resultFormat: 'json', onError: 'fail' }],
    outputTemplate: '${var:health}',
  } },
});

describe('Static Builder capture and failure settings (#537/#538)', () => {
  it('round-trips capture, format, policy, and output template through Save and reopen', async () => {
    const node = fixture();
    const onSave = jest.fn();
    const { rerender } = render(<StaticNodePropertiesModal open node={node} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('Capture result in variable')).toHaveValue('health');
    expect(screen.getByRole('combobox', { name: 'Captured result format' })).toHaveTextContent('JSON');
    expect(screen.getByRole('combobox', { name: 'When the real tool call fails' })).toHaveTextContent('Fail the run');
    fireEvent.change(screen.getByLabelText('Capture result in variable'), { target: { value: 'probe' } });
    fireEvent.click(screen.getByRole('button', { name: /Node settings/ }));
    fireEvent.change(screen.getByLabelText('Flow output template'), { target: { value: 'Observed: ${var:probe}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('static', expect.objectContaining({ properties: expect.objectContaining({
      outputTemplate: 'Observed: ${var:probe}',
      entries: [expect.objectContaining({ captureVariable: 'probe', resultFormat: 'json', onError: 'fail' })],
    }) }));
    const reopened = { ...node, data: onSave.mock.calls[0][1] };
    rerender(<StaticNodePropertiesModal open node={reopened} onSave={onSave} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Capture result in variable')).toHaveValue('probe'));
    expect(screen.getByLabelText('Flow output template')).toHaveValue('Observed: ${var:probe}');
  });

  it('blocks invalid capture names and clears an incompatible fail policy when switching to mock', () => {
    const onSave = jest.fn();
    render(<StaticNodePropertiesModal open node={fixture()} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Capture result in variable'), { target: { value: 'invalid name' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Capture result in variable'), { target: { value: 'health' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mocked result' }));
    expect(screen.queryByRole('combobox', { name: 'When the real tool call fails' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][1].properties.entries[0]).toMatchObject({ executionMode: 'mock' });
    expect(onSave.mock.calls[0][1].properties.entries[0].onError).toBeUndefined();
  });
});
