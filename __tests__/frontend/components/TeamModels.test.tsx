import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { Model } from '@/shared/types';

const mockParams = new URLSearchParams(); const mockRefresh = jest.fn();
const mockLoadModels = jest.fn(); const mockPrivateSave = jest.fn(); const mockDiscover = jest.fn();
const mockTeams = jest.fn(); const mockResources = jest.fn(); const mockAcquire = jest.fn();
const mockCreate = jest.fn(); const mockSave = jest.fn(); const mockRelease = jest.fn(); const mockRenew = jest.fn();
jest.mock('next/navigation', () => ({ useSearchParams: () => mockParams, useRouter: () => ({ refresh: mockRefresh }) }));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ globalEnvVars: {}, settings: {} }) }));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({ useAskFlujo: mockUseAskFlujo, useAskFlujoPage: mockUseAskFlujoPage }));
jest.mock('@/frontend/services/model', () => ({
  getModelService: () => ({ loadModels: mockLoadModels, addModel: mockPrivateSave, updateModel: mockPrivateSave }),
  modelService: { fetchProviderModels: (...args: unknown[]) => mockDiscover(...args) },
}));
jest.mock('@/frontend/services/teams', () => ({
  ...jest.requireActual('@/frontend/services/teams'),
  teamService: { teams: () => mockTeams(), resources: (...args: unknown[]) => mockResources(...args),
    acquire: (...args: unknown[]) => mockAcquire(...args), create: (...args: unknown[]) => mockCreate(...args),
    save: (...args: unknown[]) => mockSave(...args), release: (...args: unknown[]) => mockRelease(...args),
    renew: (...args: unknown[]) => mockRenew(...args), historyUrl: () => '/_account/resources?team=fixture',
    accessUrl: () => '/_account/resources?team=fixture&access=1' },
}));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/shared/PromptBuilder', () => ({ __esModule: true, default: () => null }));
import TeamModels from '@/frontend/components/Teams/TeamModels';
import { publishableModel, TeamRequestError } from '@/frontend/services/teams';

const teamId = 't'.repeat(43); const id = 'r'.repeat(43);
const source: Model = { id: 'private-model', name: 'local-fixture', displayName: 'Local fixture', ApiKey: 'private-secret',
  provider: 'ollama', adapter: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', promptTemplate: 'Original prompt', folder: 'private-folder' };
const team = { id: teamId, name: 'Offline team', creatorId: 'alice', generation: 1, createdAt: 1 };
const resource = { id, teamId, name: 'Team fixture', kind: 'model', format: 'flujo.model.v1', version: 1, creatorId: 'alice', createdAt: 1 };
beforeEach(() => {
  jest.clearAllMocks(); mockTeams.mockResolvedValue({ teams: [team] }); mockResources.mockResolvedValue({ team, resources: [] });
  mockLoadModels.mockResolvedValue([source]); mockCreate.mockResolvedValue({ location: '/_account/resources?resource=created' });
  mockSave.mockResolvedValue({ location: '/_account/resources?resource=saved' }); mockRelease.mockResolvedValue({ location: '/_account/resources' });
  mockRenew.mockResolvedValue({ expiresAt: Date.now() + 120_000 });
});
const show = () => render(<ThemeProvider theme={createTheme()}><TeamModels /></ThemeProvider>);

it('reviews a private model and publishes only its configuration through the team API', async () => {
  show(); const share = screen.getByRole('button', { name: 'Share a model' });
  await waitFor(() => expect(share).toBeEnabled()); fireEvent.click(share);
  const select = await screen.findByRole('combobox', { name: 'Your model' }); fireEvent.mouseDown(select);
  fireEvent.click(screen.getByRole('option', { name: 'Local fixture' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review shared copy' }));
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'Reviewed team prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Share with Offline team' }));
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
  const [destination, name, content] = mockCreate.mock.calls[0];
  expect(destination).toBe(teamId); expect(name).toBe('Local fixture');
  expect(JSON.parse(content)).toMatchObject({ format: 'flujo.model.v1', model: { name: 'local-fixture', promptTemplate: 'Reviewed team prompt' } });
  expect(content).not.toContain('private-'); expect(content).not.toContain('ApiKey');
  expect(mockPrivateSave).not.toHaveBeenCalled(); expect(mockDiscover).not.toHaveBeenCalled();
  expect(await screen.findByText('The team model was saved.')).toBeInTheDocument();
});

it('a revoked shared edit retains its draft and discard releases only its own lease', async () => {
  const lease = { token: 'l'.repeat(43), fence: 7, version: 1, expiresAt: Date.now() + 120_000 };
  mockResources.mockResolvedValue({ team, resources: [resource] });
  mockAcquire.mockResolvedValue({ resource, revision: { content: JSON.stringify(publishableModel({ ...source })) }, lease });
  mockSave.mockRejectedValue(new TeamRequestError('Your membership ended.', 404));
  show(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const prompt = await screen.findByLabelText('Prompt template'); fireEvent.change(prompt, { target: { value: 'Keep my revised prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
  expect(await screen.findByText(/Your membership ended\./)).toBeInTheDocument();
  expect(prompt).toHaveValue('Keep my revised prompt'); expect(screen.getByRole('button', { name: 'Save team revision' })).toBeDisabled();
  expect(mockSave.mock.calls[0].slice(0, 3)).toEqual([teamId, id, lease]); expect(mockPrivateSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard and close' }));
  await waitFor(() => expect(mockRelease).toHaveBeenCalledWith(teamId, id, lease));
});
