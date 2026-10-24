import React from 'react';
import { deserialize, serialize } from 'node:v8';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { SharedFlowDocument } from '@/frontend/services/teams';

const mockParams = new URLSearchParams(); const mockPrivateLoad = jest.fn(); const mockPrivateSave = jest.fn();
const mockTeams = jest.fn(); const mockResources = jest.fn(); const mockAcquire = jest.fn();
const mockCreate = jest.fn(); const mockSave = jest.fn(); const mockRelease = jest.fn(); const mockRenew = jest.fn();
jest.mock('next/navigation', () => ({ useSearchParams: () => mockParams }));
jest.mock('@/frontend/services/flow', () => ({ flowService: { loadFlows: (...args: unknown[]) => mockPrivateLoad(...args), saveFlow: (...args: unknown[]) => mockPrivateSave(...args) } }));
jest.mock('@/frontend/services/teams', () => ({
  ...jest.requireActual('@/frontend/services/teams'),
  teamService: { teams: () => mockTeams(), resources: (...args: unknown[]) => mockResources(...args),
    acquire: (...args: unknown[]) => mockAcquire(...args), createFlow: (...args: unknown[]) => mockCreate(...args),
    save: (...args: unknown[]) => mockSave(...args), release: (...args: unknown[]) => mockRelease(...args),
    renew: (...args: unknown[]) => mockRenew(...args), historyUrl: () => '/_account/resources?team=fixture' },
}));
jest.mock('@/frontend/components/Teams/TeamFlowEditor', () => ({ __esModule: true,
  default: ({ value, onChange, onDraftFieldsChange, initialDraftFields }: { value: SharedFlowDocument;
    onChange: (value: SharedFlowDocument) => void; onDraftFieldsChange: (fields: Record<string, string>) => void;
    initialDraftFields: Record<string, string> }) => <>
    <input aria-label="Graph name" value={value.flow.name} onChange={event => onChange({ ...value, flow: { ...value.flow, name: event.target.value } })} />
    <button onClick={() => onDraftFieldsChange({ 'step:maxTurns': 'unfinished[' })}>Enter unfinished field</button>
    <output data-testid="raw-fields">{JSON.stringify(initialDraftFields)}</output>
  </>,
}));
import TeamFlows from '@/frontend/components/Teams/TeamFlows';
import { TeamRequestError } from '@/frontend/services/teams';

const teamId = 't'.repeat(43); const id = 'r'.repeat(43);
const team = { id: teamId, name: 'Offline team', creatorId: 'alice', generation: 1, createdAt: 1 };
const resource = { id, teamId, name: 'Shared graph', kind: 'flow', format: 'flujo.flow.v1', version: 1, creatorId: 'alice', createdAt: 1 };
const document: SharedFlowDocument = { format: 'flujo.flow.v1', flow: { name: 'Reviewed graph', nodes: [
  { id: 'step', type: 'process', position: { x: 0, y: 0 }, data: { type: 'process', label: 'Answer', properties: { maxTurns: 4 } } },
], edges: [] } };
const lease = { token: 'l'.repeat(43), fence: 7, version: 1, expiresAt: Date.now() + 120_000 };
const show = () => render(<ThemeProvider theme={createTheme()}><TeamFlows /></ThemeProvider>);
const priorClone = globalThis.structuredClone;
beforeAll(() => { globalThis.structuredClone = value => deserialize(serialize(value)); });
afterAll(() => { globalThis.structuredClone = priorClone; });
beforeEach(() => {
  jest.clearAllMocks(); mockParams.delete('resource'); mockParams.delete('team');
  mockTeams.mockResolvedValue({ teams: [team] }); mockResources.mockResolvedValue({ team, resources: [] });
  mockAcquire.mockResolvedValue({ resource, revision: { content: JSON.stringify(document) }, lease });
  mockCreate.mockResolvedValue({ location: '/_account/resources?resource=created' }); mockSave.mockResolvedValue({ location: '/_account/resources?resource=saved' });
  mockRelease.mockResolvedValue({ location: '/_account/resources' }); mockRenew.mockResolvedValue({ expiresAt: Date.now() + 120_000 });
  mockPrivateLoad.mockResolvedValue([{ id: 'private-flow', ...document.flow, folder: 'private-folder' }]);
});

it('reads private Flows only after an explicit request, then reviews and publishes an authored copy', async () => {
  show(); const share = screen.getByRole('button', { name: 'Share an existing Flow' });
  await waitFor(() => expect(share).toBeEnabled()); expect(mockPrivateLoad).not.toHaveBeenCalled(); fireEvent.click(share);
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Your Flow' }));
  fireEvent.click(screen.getByRole('option', { name: 'Reviewed graph' })); fireEvent.click(screen.getByRole('button', { name: 'Review shared copy' }));
  fireEvent.change(screen.getByLabelText('Graph name'), { target: { value: 'Reviewed team copy' } });
  const save = await screen.findByRole('button', { name: 'Save team revision' }); expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed/ })); fireEvent.click(save);
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
  const [destination, name, content] = mockCreate.mock.calls[0];
  expect(destination).toBe(teamId); expect(name).toBe('Reviewed team copy');
  expect(JSON.parse(content)).toMatchObject({ format: 'flujo.flow.v1', flow: { name: 'Reviewed team copy' } });
  expect(content).not.toContain('private-'); expect(mockPrivateSave).not.toHaveBeenCalled();
  expect(await screen.findByText('The team Flow was saved.')).toBeInTheDocument();
});

it('retains a revoked edit and releases its own lease when the user discards it', async () => {
  mockResources.mockResolvedValue({ team, resources: [resource] }); mockSave.mockRejectedValue(new TeamRequestError('Membership ended.', 404));
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const name = await screen.findByLabelText('Graph name'); fireEvent.change(name, { target: { value: 'Keep this edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
  expect(await screen.findByText('Membership ended.')).toBeInTheDocument(); expect(name).toHaveValue('Keep this edit');
  expect(screen.getByRole('button', { name: 'Save team revision' })).toBeDisabled();
  expect(mockSave.mock.calls[0].slice(0, 3)).toEqual([teamId, id, lease]); expect(mockPrivateSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(await screen.findByRole('button', { name: 'Discard and close' }));
  await waitFor(() => expect(mockRelease).toHaveBeenCalledWith(teamId, id, lease));
});

it('downloads pending JSON edits and reloads them after reacquiring the current revision', async () => {
  mockResources.mockResolvedValue({ team, resources: [resource] });
  const createUrl = jest.fn((_blob: Blob) => 'blob:fixture'); const revokeUrl = jest.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    const view = show(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enter unfinished field' }));
    expect(screen.getByRole('button', { name: 'Save team revision' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Download draft' }));
    expect(createUrl).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1);
    const blob = createUrl.mock.calls[0][0] as Blob;
    const raw = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });
    expect(JSON.parse(raw).pendingFields).toEqual({ 'step:maxTurns': 'unfinished[' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(await screen.findByRole('button', { name: 'Discard and close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' })); await screen.findByLabelText('Graph name');
    const file = new File([raw], 'recovered.json', { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => raw });
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('raw-fields')).toHaveTextContent('unfinished['));
    expect(screen.getByText(/Enter valid JSON.*Answer: maxTurns/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save team revision' })).toBeDisabled();
  } finally { click.mockRestore(); }
});
