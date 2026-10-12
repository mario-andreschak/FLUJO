import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RemoteTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/RemoteTab';

const probe = jest.fn();
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: { probeOAuthCapability: (...args: unknown[]) => probe(...args) } }));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/SamplingManager', () => ({ __esModule: true, default: () => null }));

beforeEach(() => probe.mockReset());

test.each(['http://127.0.0.1:8787/mcp', 'https://mcp.example.com:8443/mcp'])
('manual setup preserves %s and waits for explicit testing', url => {
  const onHandoff = jest.fn();
  render(<RemoteTab onAdd={jest.fn()} onClose={jest.fn()} onHandoff={onHandoff} />);
  expect(screen.getByText('mcp.remote.discoveryLimits')).toBeVisible();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'mcp.remote.manualSetup' }));
  expect(probe).not.toHaveBeenCalled();
  expect(onHandoff).toHaveBeenCalledWith({ to: 'configure', autoTestRun: false,
    config: expect.objectContaining({ transport: 'streamable', serverUrl: url, source: { type: 'remote' } }) });
});

test('Connect still hands a local URL to normal connection testing when its optional preview returns no result', async () => {
  probe.mockResolvedValue({ oauthCapable: false });
  const onHandoff = jest.fn();
  render(<RemoteTab onAdd={jest.fn()} onClose={jest.fn()} onHandoff={onHandoff} />);
  const url = 'http://localhost:8787/mcp';
  fireEvent.change(screen.getByRole('textbox'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'mcp.remote.connect' }));
  await waitFor(() => expect(onHandoff).toHaveBeenCalledWith({ to: 'configure', autoTestRun: true,
    config: expect.objectContaining({ serverUrl: url }) }));
});
