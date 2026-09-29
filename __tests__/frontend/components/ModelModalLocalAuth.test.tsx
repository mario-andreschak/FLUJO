import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { Model } from '@/shared/types';

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

function showModel(provider: Model['provider'], adapter: Model['adapter'], name = '', metadata: Partial<Model> = {}) {
  const model: Model = {
    id: 'local-auth-fixture', provider, adapter, name, displayName: name,
    ApiKey: '', baseUrl: '', promptTemplate: '',
    temperature: '0.5', reasoningEffort: 'high', thinkingLevel: 'high',
    thinkingBudget: 1024, serviceTier: 'priority', maxTokens: 500,
    ...metadata,
  };
  const onSave = jest.fn(async (saved: Model) => ({ success: true, model: saved }));
  render(<ThemeProvider theme={createTheme()}><ModelModal open model={model} onSave={onSave} onClose={jest.fn()} /></ThemeProvider>);
  return onSave;
}

it('saves a Gemini CLI connection without a key and removes unsupported generation settings', async () => {
  const onSave = showModel('gemini-cli', 'gemini-cli');
  expect(screen.getByLabelText('API key')).not.toBeRequired();
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'My Gemini CLI' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'auto' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({
    provider: 'gemini-cli', adapter: 'gemini-cli', ApiKey: '', name: 'auto',
    temperature: undefined, reasoningEffort: undefined, thinkingLevel: undefined,
    thinkingBudget: undefined, serviceTier: undefined, maxTokens: undefined,
  });
});

it.each(['gemini-cli', undefined] as const)('shows an empty key when editing a saved Gemini CLI local-login connection with adapter %s', adapter => {
  showModel('gemini-cli', adapter, 'auto');
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByText(/Optional for an eligible Code Assist Standard or Enterprise/)).toBeInTheDocument();
});

it('still requires a key for the native Gemini provider', () => {
  const onSave = showModel('gemini', 'gemini');
  const key = screen.getByLabelText(/API key/);
  expect(key).toBeRequired();
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Native Gemini' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'gemini-2.5-pro' } });
  fireEvent.submit(screen.getByRole('button', { name: /^Save$/ }).closest('form')!);
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText('API key is required')).toBeInTheDocument();
});

it.each(['gemini-cli', undefined] as const)('removes CLI input restrictions when switching adapter %s to native Gemini', async adapter => {
  const onSave = showModel('gemini-cli', adapter, '', {
    inputModalities: ['text'], visionInputCapability: 'unsupported',
    outputModalities: ['text'], contextWindow: 32768,
  });
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /^Provider$/ }));
  fireEvent.click(screen.getByRole('option', { name: 'Gemini (Native)' }));
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Native Gemini' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'gemini-2.5-pro' } });
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'gemini-api-key' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({
    provider: 'gemini', adapter: 'gemini', inputModalities: undefined,
    visionInputCapability: 'unknown', outputModalities: ['text'], contextWindow: 32768,
  });
});

it('preserves saved text-only metadata when a different provider switches to native Gemini', async () => {
  const onSave = showModel('openai', 'openai', '', {
    inputModalities: ['text'], visionInputCapability: 'unsupported',
  });
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /^Provider$/ }));
  fireEvent.click(screen.getByRole('option', { name: 'Gemini (Native)' }));
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Native Gemini' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'gemini-2.5-pro' } });
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'gemini-api-key' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({
    provider: 'gemini', adapter: 'gemini', inputModalities: ['text'], visionInputCapability: 'unsupported',
  });
});
