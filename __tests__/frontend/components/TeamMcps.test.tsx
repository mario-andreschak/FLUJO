import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

let mockParams = new URLSearchParams(); const mockPrivateLoad = jest.fn(); const mockPrivateSave = jest.fn();
const mockTeams = jest.fn(); const mockResources = jest.fn(); const mockAcquire = jest.fn();
const mockCreate = jest.fn(); const mockSave = jest.fn(); const mockRelease = jest.fn(); const mockRenew = jest.fn();
jest.mock('next/navigation', () => ({ useSearchParams: () => mockParams }));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: { loadServerConfigs: () => mockPrivateLoad(), updateServerConfig: (...args: unknown[]) => mockPrivateSave(...args) } }));
jest.mock('@/frontend/services/teams', () => ({
  ...jest.requireActual('@/frontend/services/teams'),
  teamService: { teams: () => mockTeams(), resources: (...args: unknown[]) => mockResources(...args),
    acquire: (...args: unknown[]) => mockAcquire(...args), createMcp: (...args: unknown[]) => mockCreate(...args),
    save: (...args: unknown[]) => mockSave(...args), release: (...args: unknown[]) => mockRelease(...args),
    renew: (...args: unknown[]) => mockRenew(...args), historyUrl: () => '/_account/resources?team=fixture' },
}));
import TeamMcps from '@/frontend/components/Teams/TeamMcps';
import { TeamRequestError } from '@/frontend/services/teams';

const teamId = 't'.repeat(43); const id = 'r'.repeat(43);
const team = { id: teamId, name: 'Offline team', creatorId: 'alice', generation: 1, createdAt: 1 };
const resource = { id, teamId, name: 'Shared server', kind: 'mcp', format: 'flujo.mcp.v1', version: 1, creatorId: 'alice', createdAt: 1 };
const document = { format: 'flujo.mcp.v1', mcp: { name: 'Shared server', transport: 'stdio', command: 'node', args: ['server.mjs'] } };
const lease = { token: 'l'.repeat(43), fence: 7, version: 1, expiresAt: Date.now() + 120_000 };
const show = () => render(<ThemeProvider theme={createTheme()}><TeamMcps /></ThemeProvider>);
beforeEach(() => {
  jest.clearAllMocks(); mockParams.delete('resource'); mockParams.delete('team'); lease.expiresAt = Date.now() + 120_000;
  mockTeams.mockResolvedValue({ teams: [team] }); mockResources.mockResolvedValue({ team, resources: [] });
  mockAcquire.mockResolvedValue({ resource, revision: { content: JSON.stringify(document) }, lease });
  mockCreate.mockResolvedValue({ location: '/_account/resources?resource=created' }); mockSave.mockResolvedValue({ location: '/_account/resources?resource=saved' });
  mockRelease.mockResolvedValue({ location: '/_account/resources' }); mockRenew.mockResolvedValue({ expiresAt: Date.now() + 120_000 });
  mockPrivateLoad.mockResolvedValue([{ ...document.mcp, command: 'private-command', args: ['--token=private-secret'],
    env: { SECRET: 'private-environment' }, roots: ['private-root'], oauthTokens: 'private-oauth' }]);
});

it('reviews a private server without copying executable arguments or invoking private save or connect actions', async () => {
  show(); const share = screen.getByRole('button', { name: 'Share an existing MCP server' });
  await waitFor(() => expect(share).toBeEnabled()); expect(mockPrivateLoad).not.toHaveBeenCalled(); fireEvent.click(share);
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Your MCP server' }));
  fireEvent.click(screen.getByRole('option', { name: 'Shared server' })); fireEvent.click(screen.getByRole('button', { name: 'Review shared copy' }));
  const command = await screen.findByLabelText('Command'); expect(command).toHaveValue('');
  expect(screen.queryByLabelText('Arguments 1')).not.toBeInTheDocument();
  expect(screen.queryByText('private-secret')).not.toBeInTheDocument();
  fireEvent.change(command, { target: { value: 'node' } }); fireEvent.click(await screen.findByRole('button', { name: 'Add Arguments' }));
  fireEvent.change(screen.getByLabelText('Arguments 1'), { target: { value: 'reviewed.mjs' } });
  const save = screen.getByRole('button', { name: 'Save team revision' }); expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed/ })); fireEvent.click(save);
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
  const [destination, name, content] = mockCreate.mock.calls[0]; expect(destination).toBe(teamId); expect(name).toBe('Shared server');
  expect(JSON.parse(content)).toEqual({ format: 'flujo.mcp.v1', mcp: { name: 'Shared server', transport: 'stdio', command: 'node', args: ['reviewed.mjs'] } });
  expect(content).not.toContain('private-'); expect(mockPrivateSave).not.toHaveBeenCalled();
  expect(await screen.findByText('The team MCP configuration was saved.')).toBeInTheDocument();
});

it('preserves revoked edits, refuses another save, and releases only its acquired lease on discard', async () => {
  mockResources.mockResolvedValue({ team, resources: [resource] }); mockSave.mockRejectedValue(new TeamRequestError('Membership ended.', 404));
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const name = await screen.findByLabelText('Server name'); fireEvent.change(name, { target: { value: 'Keep this edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
  expect(await screen.findByText('Membership ended.')).toBeInTheDocument(); expect(name).toHaveValue('Keep this edit');
  expect(screen.getByRole('button', { name: 'Save team revision' })).toBeDisabled();
  expect(mockSave.mock.calls[0].slice(0, 3)).toEqual([teamId, id, lease]); expect(mockPrivateSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(await screen.findByRole('button', { name: 'Discard and close' }));
  await waitFor(() => expect(mockRelease).toHaveBeenCalledWith(teamId, id, lease));
});

it('keeps the publication destination visible when the route selection changes during an edit', async () => {
  const other = { ...team, id: 'o'.repeat(43), name: 'Other team' };
  mockTeams.mockResolvedValue({ teams: [team, other] });
  const view = show(); const create = screen.getByRole('button', { name: 'New team MCP server' });
  await waitFor(() => expect(create).toBeEnabled()); fireEvent.click(create);
  await screen.findByLabelText('Command');
  mockParams = new URLSearchParams({ team: other.id });
  view.rerender(<ThemeProvider theme={createTheme()}><TeamMcps /></ThemeProvider>);
  await waitFor(() => expect(mockTeams).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mockResources).toHaveBeenCalledWith(other.id));
  expect(screen.getByRole('combobox', { name: 'Team' })).toHaveTextContent('Offline team');
  const consent = screen.getByRole('checkbox', { name: /share this configuration with Offline team/ });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } }); fireEvent.click(consent);
  fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1)); expect(mockCreate.mock.calls[0][0]).toBe(teamId);
});

it('clears incompatible transport fields and recovers incomplete endpoints through a downloaded draft', async () => {
  mockResources.mockResolvedValue({ team, resources: [resource] });
  const createUrl = jest.fn((_blob: Blob) => 'blob:fixture');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    const view = show(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Transport' })); fireEvent.click(screen.getByRole('option', { name: 'streamable' }));
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Server endpoint'), { target: { value: 'unfinished://' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
    expect(await screen.findByText(/Invalid shared MCP configuration/)).toBeInTheDocument(); expect(mockSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download draft' }));
    const raw = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(createUrl.mock.calls[0][0]); });
    expect(JSON.parse(raw).document.mcp).toEqual({ name: 'Shared server', transport: 'streamable', serverUrl: 'unfinished://' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(await screen.findByRole('button', { name: 'Discard and close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' })); await screen.findByLabelText('Command');
    const file = new File([raw], 'recovered.json', { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => raw });
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('Server endpoint')).toHaveValue('unfinished://'));
    fireEvent.change(screen.getByLabelText('Server endpoint'), { target: { value: 'https://example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(mockSave.mock.calls[0][4]).mcp).toEqual({ name: 'Shared server', transport: 'streamable', serverUrl: 'https://example.com/mcp' });
  } finally { click.mockRestore(); }
});
