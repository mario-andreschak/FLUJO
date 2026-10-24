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

it('clears another model output ceiling when selecting Free whose catalogue ceiling is unknown', async () => {
  mockDiscover.mockResolvedValue([
    { id: 'recursive/flint-v1.0:free', name: 'Flint', contextWindow: 262_144, maxTokens: 235_929 },
    { id: 'openrouter/free', name: 'Free', contextWindow: 200_000 },
  ]);
  const save = jest.fn(async (_model: Model) => ({ success: true }));
  render(<ThemeProvider theme={createTheme()}><ModelModal open
    model={{ ...model, provider: 'openrouter', adapter: 'openai-responses', name: 'recursive/flint-v1.0:free',
      baseUrl: 'https://openrouter.ai/api/v1', ApiKey: 'offline-fixture', contextWindow: 262_144, maxTokens: 235_929 }}
    onSave={save} onClose={jest.fn()} /></ThemeProvider>);
  await waitFor(() => expect(mockDiscover).toHaveBeenCalled());
  const name = screen.getByRole('combobox', { name: 'Technical name' });
  fireEvent.change(name, { target: { value: 'openrouter/free' } });
  fireEvent.keyDown(name, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'openrouter/free' }));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0]).toMatchObject({ name: 'openrouter/free', contextWindow: 200_000 });
  expect(save.mock.calls[0][0].maxTokens).toBeUndefined();
});

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

it('discovers Antigravity account models without a key, retains a custom slug and exposes no unverified effort', async () => {
  mockDiscover.mockResolvedValue([{ id: 'future/custom-model', name: 'Custom model' }]);
  const save = jest.fn(async (_model: Model) => ({ success: true }));
  render(<ThemeProvider theme={createTheme()}><ModelModal open model={{ ...model, provider: 'antigravity-cli', adapter: 'antigravity-cli', name: 'saved/custom' }} onSave={save} onClose={jest.fn()} /></ThemeProvider>);
  await waitFor(() => expect(mockDiscover).toHaveBeenCalledWith('', 'subscription', undefined, '', 'antigravity-cli'));
  const name = screen.getByRole('combobox', { name: 'Technical name' });
  fireEvent.change(name, { target: { value: 'future/custom-model' } });
  fireEvent.keyDown(name, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: /Custom model future\/custom-model/ }));
  expect(screen.queryByRole('combobox', { name: 'Effort' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0]).toMatchObject({ name: 'future/custom-model', ApiKey: '' });
});
