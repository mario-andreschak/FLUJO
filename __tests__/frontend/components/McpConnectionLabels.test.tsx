import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { mcpMessageRows } from '@/frontend/i18n/catalogs/mcp';
import LocalServerForm from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/LocalServerForm';
import RunTools from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/RunTools';
import RemoteTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/RemoteTab';

let mockLocale = 0;
const mockProbe = jest.fn();
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string) => mcpMessageRows[key as keyof typeof mcpMessageRows]?.[mockLocale] ?? key,
    formatNumber: String,
  }),
}));
jest.mock('@/frontend/services/mcp', () => ({
  mcpService: { probeOAuthCapability: (...args: unknown[]) => mockProbe(...args) },
}));
jest.mock('@/frontend/components/mcp/MCPEnvManager/EnvEditor', () => () => <div />);
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/HeadersEditor', () => () => <div />);
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/OAuthCredentialsEditor', () => () => <div />);
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/SamplingManager', () => () => <div />);

const localProps = () => ({
  name: '', setName: jest.fn(), rootPath: '', setRootPath: jest.fn(), onRootPathSelect: jest.fn(),
});
const runProps = (transport: 'stdio' | 'websocket' | 'sse' | 'streamable') => ({
  command: 'node', setCommand: jest.fn(), transport, setTransport: jest.fn(),
  websocketUrl: 'ws://127.0.0.1:9317', setWebsocketUrl: jest.fn(),
  serverUrl: 'http://127.0.0.1:9317/mcp', setServerUrl: jest.fn(),
  onRun: jest.fn(async () => undefined), isRunning: false, runCompleted: false,
  env: {}, onEnvChange: jest.fn(), serverName: 'owned-label-fixture', consoleOutput: '',
  message: null, setMessage: jest.fn(), onSaveAndAuthenticate: jest.fn(),
  oauthCapable: transport === 'sse' || transport === 'streamable',
});

function expectAssociatedLabel(input: HTMLElement, name: string) {
  const control = input as HTMLInputElement;
  expect(control).toHaveAccessibleName(name);
  expect(control.labels).toHaveLength(1);
  const label = control.labels![0];
  expect(label).toHaveTextContent(name);
  expect(label.control).toBe(control);
}

beforeEach(() => {
  mockLocale = 0;
  mockProbe.mockReset();
});

it('names the remote URL input without connecting, probing or saving while editing', () => {
  const onAdd = jest.fn();
  const onClose = jest.fn();
  const onHandoff = jest.fn();
  render(<RemoteTab onAdd={onAdd} onClose={onClose} onHandoff={onHandoff} />);
  const input = screen.getByRole('textbox', { name: 'Server URL' });
  expectAssociatedLabel(input, 'Server URL');
  fireEvent.change(input, { target: { value: 'https://example.invalid/owned-label' } });
  expect(input).toHaveValue('https://example.invalid/owned-label');
  expect(mockProbe).not.toHaveBeenCalled();
  expect(onAdd).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(onHandoff).not.toHaveBeenCalled();
});

it.each([
  ['Server name', 'setName'],
  ['MCP server root path', 'setRootPath'],
] as const)('associates the visible %s label with its editable control', (name, setter) => {
  const props = localProps();
  render(<LocalServerForm {...props} />);
  const input = screen.getByRole('textbox', { name });
  expectAssociatedLabel(input, name);
  fireEvent.change(input, { target: { value: 'synthetic-label-value' } });
  expect(props[setter]).toHaveBeenCalledWith('synthetic-label-value');
  expect(props.onRootPathSelect).not.toHaveBeenCalled();
});

it.each([
  ['stdio', 'Run command', 'setCommand'],
  ['websocket', 'WebSocket URL', 'setWebsocketUrl'],
  ['sse', 'Server URL', 'setServerUrl'],
  ['streamable', 'Server URL', 'setServerUrl'],
] as const)('names the %s input without testing or authenticating while editing', (transport, name, setter) => {
  const props = runProps(transport);
  render(<RunTools {...props} />);
  const input = screen.getByRole('textbox', { name });
  expectAssociatedLabel(input, name);
  fireEvent.change(input, { target: { value: 'synthetic-edited-value' } });
  expect(props[setter]).toHaveBeenCalledWith('synthetic-edited-value');
  expect(props.onRun).not.toHaveBeenCalled();
  expect(props.onSaveAndAuthenticate).not.toHaveBeenCalled();
});

it.each(['local', 'runner', 'remote'] as const)('repeated %s forms label their own controls under StrictMode', kind => {
  const form = () => kind === 'local'
    ? <LocalServerForm {...localProps()} />
    : kind === 'runner'
      ? <RunTools {...runProps('streamable')} />
      : <RemoteTab onAdd={jest.fn()} onClose={jest.fn()} onHandoff={jest.fn()} />;
  render(<React.StrictMode>{form()}{form()}</React.StrictMode>);
  const inputs = screen.getAllByRole('textbox');
  expect(inputs).toHaveLength(kind === 'local' ? 4 : 2);
  expect(new Set(inputs.map(input => input.id)).size).toBe(inputs.length);
  for (const input of inputs) {
    const control = input as HTMLInputElement;
    expect(control.labels).toHaveLength(1);
    expect(control.labels![0].control).toBe(control);
    expect(control).toHaveAccessibleName(control.labels![0].textContent!);
  }
});

it.each([
  ['en', 0], ['es', 1], ['de', 2], ['fr', 3], ['it', 4], ['pt', 5], ['zh-CN', 6],
] as const)('exposes all connection field labels in %s', (_locale, index) => {
  mockLocale = index;
  render(<>
    <LocalServerForm {...localProps()} />
    <RunTools {...runProps('stdio')} />
    <RunTools {...runProps('websocket')} />
    <RunTools {...runProps('sse')} />
    <RunTools {...runProps('streamable')} />
    <RemoteTab onAdd={jest.fn()} onClose={jest.fn()} onHandoff={jest.fn()} />
  </>);
  const inputs = screen.getAllByRole('textbox');
  const keys = [
    'mcp.local.form.name', 'mcp.local.form.rootPath', 'mcp.local.run.command',
    'mcp.local.run.websocketUrl', 'mcp.local.run.serverUrl', 'mcp.local.run.serverUrl',
    'mcp.remote.url',
  ] as const;
  expect(inputs).toHaveLength(keys.length);
  expect(new Set(inputs.map(input => input.id)).size).toBe(inputs.length);
  keys.forEach((key, position) => expectAssociatedLabel(inputs[position], mcpMessageRows[key][index]));
});

it('keeps field associations and configured values across transport changes', () => {
  const props = runProps('stdio');
  const { rerender } = render(<RunTools {...props} />);
  const command = screen.getByRole('textbox', { name: 'Run command' });
  const commandId = command.id;
  expect(command).toHaveValue('node');
  rerender(<RunTools {...props} transport="websocket" />);
  expectAssociatedLabel(screen.getByRole('textbox', { name: 'WebSocket URL' }), 'WebSocket URL');
  expect(screen.getByRole('textbox', { name: 'WebSocket URL' })).toHaveValue(props.websocketUrl);
  rerender(<RunTools {...props} transport="sse" />);
  const server = screen.getByRole('textbox', { name: 'Server URL' });
  const serverId = server.id;
  expectAssociatedLabel(server, 'Server URL');
  expect(server).toHaveValue(props.serverUrl);
  rerender(<RunTools {...props} transport="streamable" />);
  expect(screen.getByRole('textbox', { name: 'Server URL' })).toHaveAttribute('id', serverId);
  rerender(<RunTools {...props} />);
  expect(screen.getByRole('textbox', { name: 'Run command' })).toHaveAttribute('id', commandId);
  expect(screen.getByRole('textbox', { name: 'Run command' })).toHaveValue('node');
  expect(props.onRun).not.toHaveBeenCalled();
  expect(props.onSaveAndAuthenticate).not.toHaveBeenCalled();
});

it.each(['http://127.0.0.1:8787/mcp', 'https://mcp.example.com:8443/mcp'])
('preserves %s for manual setup through the named URL control', url => {
  const onAdd = jest.fn();
  const onHandoff = jest.fn();
  render(<RemoteTab onAdd={onAdd} onClose={jest.fn()} onHandoff={onHandoff} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Server URL' }), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: mcpMessageRows['mcp.remote.manualSetup'][0] }));
  expect(mockProbe).not.toHaveBeenCalled();
  expect(onAdd).not.toHaveBeenCalled();
  expect(onHandoff).toHaveBeenCalledTimes(1);
  expect(onHandoff).toHaveBeenCalledWith({
    to: 'configure', autoTestRun: false,
    config: expect.objectContaining({ transport: 'streamable', serverUrl: url, source: { type: 'remote' } }),
  });
});
