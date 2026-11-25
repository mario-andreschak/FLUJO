import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { Model } from '@/shared/types';
jest.mock('@/frontend/services/model', () => ({ modelService: { fetchProviderModels: jest.fn(async () => []) } }));

const mockRouter = { refresh: jest.fn(), push: jest.fn() };
const mockStorage = { globalEnvVars: {}, settings: {} };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => mockStorage }));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo, useAskFlujoPage: mockUseAskFlujoPage,
}));
jest.mock('@/frontend/components/shared/PromptBuilder', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({ __esModule: true, default: () => null }));

import ModelModal from '@/frontend/components/models/modal';

const NOTE = /Creativity has no effect on Claude models/;

function showModel(metadata: Partial<Model>) {
  const model: Model = {
    id: 'claude-fixture', provider: 'anthropic', adapter: 'anthropic', name: 'claude-sonnet-4-6',
    displayName: 'Claude fixture', ApiKey: 'sk-fixture', baseUrl: '', promptTemplate: '',
    ...metadata,
  };
  const onSave = jest.fn(async (saved: Model) => ({ success: true, model: saved }));
  render(<ThemeProvider theme={createTheme()}><ModelModal open model={model} onSave={onSave} onClose={jest.fn()} /></ThemeProvider>);
  return onSave;
}

it('explains a saved Creativity that Claude no longer uses and keeps it on save', async () => {
  const onSave = showModel({ temperature: '0.7' });
  expect(screen.queryByLabelText('Creativity')).not.toBeInTheDocument();
  expect(screen.getByText(NOTE)).toHaveTextContent('(0.7)');
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({ provider: 'anthropic', adapter: 'anthropic', temperature: '0.7' });
});

it('shows no note when nothing was saved, and a new draft gets no value', async () => {
  const onSave = showModel({ temperature: '' });
  expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0].temperature).toBeUndefined();
});

it('keeps the Creativity field for the OpenAI-format Anthropic profile', () => {
  showModel({ adapter: 'openai', baseUrl: 'https://api.anthropic.com/v1/', temperature: '0.7' });
  expect(screen.getByLabelText('Creativity')).toHaveValue(0.7);
  expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
});
