import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { Model } from '@/shared/types';

const mockDiscover = jest.fn();
jest.mock('@/frontend/services/model', () => ({ modelService: { fetchProviderModels: (...args: unknown[]) => mockDiscover(...args) } }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ globalEnvVars: {}, settings: {} }) }));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({ useAskFlujo: mockUseAskFlujo, useAskFlujoPage: mockUseAskFlujoPage }));
jest.mock('@/frontend/components/shared/PromptBuilder', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({ __esModule: true, default: () => null }));
import ModelModal from '@/frontend/components/models/modal';

const model: Model = { id: 'subscription', provider: 'codex', adapter: 'codex-cli', name: 'saved-model', displayName: 'My Codex', ApiKey: '', baseUrl: '', promptTemplate: '' };

beforeEach(() => { mockDiscover.mockReset(); });

it('shows a newly returned model and its reasoning options without a static suggestion or UI release', async () => {
  mockDiscover.mockResolvedValue([{ id: 'future-7.9', name: 'Future', reasoningEfforts: ['ultra'] }]);
  const save = jest.fn(async (_model: Model) => ({ success: true }));
  render(<ThemeProvider theme={createTheme()}><ModelModal open model={model} onSave={save} onClose={jest.fn()} /></ThemeProvider>);
  await waitFor(() => expect(mockDiscover).toHaveBeenCalledWith('', 'subscription', undefined, undefined, 'codex'));
  const name = screen.getByRole('combobox', { name: 'Technical name' });
  fireEvent.change(name, { target: { value: 'future-7.9' } });
  fireEvent.keyDown(name, { key: 'ArrowDown' });
  expect(await screen.findByRole('option', { name: 'future-7.9' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: 'future-7.9' }));
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Effort' }));
  fireEvent.click(screen.getByRole('option', { name: 'ultra' }));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0]).toMatchObject({ name: 'future-7.9', reasoningEffort: 'ultra', ApiKey: '' });
});

it('preserves the saved ID during discovery failure and does not replace it with an old hardcoded model', async () => {
  mockDiscover.mockRejectedValue(new Error('offline'));
  render(<ThemeProvider theme={createTheme()}><ModelModal open model={model} onSave={jest.fn()} onClose={jest.fn()} /></ThemeProvider>);
  await waitFor(() => expect(mockDiscover).toHaveBeenCalled());
  expect(screen.getByRole('combobox', { name: 'Technical name' })).toHaveValue('saved-model');
});
