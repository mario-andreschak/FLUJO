import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { mcpMessageRows } from '@/frontend/i18n/catalogs/mcp';
import LocalServerForm from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/LocalServerForm';
import RunTools from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/RunTools';
import RemoteTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/RemoteTab';

let mockLocale = 0;
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string) => mcpMessageRows[key as keyof typeof mcpMessageRows]?.[mockLocale] ?? key,
    formatNumber: String,
  }),
}));
jest.mock('@/frontend/components/mcp/MCPEnvManager/EnvEditor', () => () => <div />);
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/HeadersEditor', () => () => <div />);
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/OAuthCredentialsEditor', () => () => <div />);

const localProps = () => ({
  name: '', setName: jest.fn(), rootPath: '', setRootPath: jest.fn(), onRootPathSelect: jest.fn(),
});
const runProps = (transport: 'stdio' | 'websocket' | 'sse' | 'streamable') => ({
  command: 'node', setCommand: jest.fn(), transport, setTransport: jest.fn(),
  websocketUrl: 'ws://127.0.0.1:9317', setWebsocketUrl: jest.fn(),
  serverUrl: 'http://127.0.0.1:9317/mcp', setServerUrl: jest.fn(),
  onRun: jest.fn(async () => undefined), isRunning: false, runCompleted: false,
  env: {}, onEnvChange: jest.fn(), serverName: 'owned-label-fixture', consoleOutput: '',
  message: null, setMessage: jest.fn(),
});

beforeEach(() => { mockLocale = 0; });

it('associates the remote connection URL label and editing does not connect or save', () => {
  const onAdd = jest.fn(async () => undefined);
  const onClose = jest.fn();
  const onHandoff = jest.fn();
  render(<RemoteTab onAdd={onAdd} onClose={onClose} onHandoff={onHandoff} />);
  const input = screen.getByRole('textbox', { name: 'Server URL', exact: true });
  const label = screen.getByText('Server URL', { exact: true });
  expect((label as HTMLLabelElement).control).toBe(input);
  fireEvent.change(input, { target: { value: 'https://example.invalid/owned-label' } });
  expect(input).toHaveValue('https://example.invalid/owned-label');
  expect(onAdd).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(onHandoff).not.toHaveBeenCalled();
});

it.each([
  ['Server name', 'name', 'setName'],
  ['MCP server root path', 'rootPath', 'setRootPath'],
] as const)('associates the visible %s label with its control', (label, _property, setter) => {
  const props = localProps();
  render(<LocalServerForm {...props} />);
  const input = screen.getByRole('textbox', { name: label, exact: true });
  const visibleLabel = screen.getByText(label, { exact: true });
  expect(visibleLabel).toBeInstanceOf(HTMLLabelElement);
  expect((visibleLabel as HTMLLabelElement).control).toBe(input);
  fireEvent.change(input, { target: { value: 'synthetic-label-value' } });
  expect(props[setter]).toHaveBeenCalledWith('synthetic-label-value');
  expect(props.onRootPathSelect).not.toHaveBeenCalled();
});

it.each([
  ['stdio', 'Run command', 'setCommand'],
  ['websocket', 'WebSocket URL', 'setWebsocketUrl'],
  ['streamable', 'Server URL', 'setServerUrl'],
] as const)('names the %s connection input and editing does not Test run', (transport, label, setter) => {
  const props = runProps(transport);
  render(<RunTools {...props} />);
  const input = screen.getByRole('textbox', { name: label, exact: true });
  const visibleLabel = screen.getByText(label, { exact: true });
  expect(visibleLabel).toBeInstanceOf(HTMLLabelElement);
  expect((visibleLabel as HTMLLabelElement).control).toBe(input);
  fireEvent.change(input, { target: { value: 'synthetic-edited-value' } });
  expect(props[setter]).toHaveBeenCalledWith('synthetic-edited-value');
  expect(props.onRun).not.toHaveBeenCalled();
});

it('repeated local forms associate each visible name with its own input', () => {
  render(<><LocalServerForm {...localProps()} /><LocalServerForm {...localProps()} /></>);
  const inputs = screen.getAllByRole('textbox', { name: 'Server name', exact: true });
  expect(inputs).toHaveLength(2);
  expect(inputs[0].id).not.toBe(inputs[1].id);
  const label = screen.getAllByText('Server name', { exact: true })[1];
  expect((label as HTMLLabelElement).control).toBe(inputs[1]);
});

it.each([
  ['en', 0], ['es', 1], ['de', 2], ['fr', 3], ['it', 4], ['pt', 5], ['zh-CN', 6],
] as const)('exposes associated connection labels in %s', (_locale, index) => {
  mockLocale = index;
  render(<>
    <LocalServerForm {...localProps()} />
    <RunTools {...runProps('stdio')} />
    <RunTools {...runProps('websocket')} />
    <RunTools {...runProps('streamable')} />
  </>);
  for (const key of [
    'mcp.local.form.name', 'mcp.local.form.rootPath', 'mcp.local.run.command',
    'mcp.local.run.websocketUrl', 'mcp.local.run.serverUrl',
  ] as const) {
    const name = mcpMessageRows[key][index];
    const input = screen.getByRole('textbox', { name, exact: true });
    const label = screen.getByText(name, { exact: true });
    expect((label as HTMLLabelElement).control).toBe(input);
  }
});
