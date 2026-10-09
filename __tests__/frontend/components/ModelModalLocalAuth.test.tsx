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

it('saves a Antigravity CLI connection without a key and removes unsupported generation settings', async () => {
  const onSave = showModel('openai', 'openai');
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /^Provider$/ }));
  fireEvent.click(screen.getByRole('option', { name: 'Antigravity CLI (Google)' }));
  expect(screen.getByLabelText('API key')).not.toBeRequired();
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'My Antigravity CLI' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'default' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({
    provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '', name: 'default',
    inputModalities: ['text'], visionInputCapability: 'unsupported', supportsTools: true,
    temperature: undefined, reasoningEffort: undefined, thinkingLevel: undefined,
    thinkingBudget: undefined, serviceTier: undefined, maxTokens: undefined,
  });
});

it.each(['antigravity-cli', undefined] as const)('shows an empty key when editing a saved Antigravity CLI local-login connection with adapter %s', adapter => {
  showModel('antigravity-cli', adapter, 'default');
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByText(/Optional when Antigravity account sign-in is available/)).toBeInTheDocument();
});

it('saves an explicit Gemini API key for the Antigravity CLI advanced profile', async () => {
  const onSave = showModel('antigravity-cli', 'antigravity-cli');
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'API Antigravity' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'default' } });
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'gemini-api-key' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({
    provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: 'gemini-api-key',
  });
});

it('groups the verified account catalog and removes account-only suggestions in API-key mode', () => {
  showModel('antigravity-cli', 'antigravity-cli');
  const modelName = screen.getByLabelText(/Technical name/);
  fireEvent.mouseDown(modelName);
  expect(screen.getByRole('option', { name: /gemini-3.8-flash-medium/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /claude-opus-4-6-thinking/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /gpt-oss-120b-medium/ })).toBeInTheDocument();
  expect(screen.getByText('CLI default')).toBeInTheDocument();
  expect(screen.getByText('Gemini')).toBeInTheDocument();
  expect(screen.getByText('Claude')).toBeInTheDocument();
  expect(screen.getByText('GPT-OSS')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'gemini-api-key' } });
  fireEvent.keyDown(modelName, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: /Antigravity CLI Default/ })).toBeInTheDocument();
  expect(screen.getAllByRole('option')).toHaveLength(12);
  expect(screen.getByRole('option', { name: /gemini-3.8-flash-medium/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /gemini-3.1-pro-high/ })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /claude-/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /gpt-oss-/ })).not.toBeInTheDocument();
});

it.each(['claude-opus-4-6-thinking', 'gpt-oss-120b-medium'])('saves the account catalog choice %s with its exact technical name', async name => {
  const onSave = showModel('antigravity-cli', 'antigravity-cli');
  fireEvent.mouseDown(screen.getByLabelText(/Technical name/));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
  expect(screen.getByLabelText(/Technical name/)).toHaveValue(name);
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'My Antigravity model' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({
    provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '', name,
  });
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

it.each(['antigravity-cli', undefined] as const)('removes CLI input restrictions when switching adapter %s to native Gemini', async adapter => {
  const onSave = showModel('antigravity-cli', adapter, '', {
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

it('selects and saves OrcaRouter with its own key, endpoint and Chat Completions adapter', async () => {
  const onSave = showModel('openai', 'openai');
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /^Provider$/ }));
  fireEvent.click(screen.getByRole('option', { name: 'OrcaRouter' }));
  expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://api.orcarouter.ai/v1');
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Orca Sonnet' } });
  fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'anthropic/claude-sonnet-4' } });
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'orca-fixture-key' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toMatchObject({ provider: 'orcarouter', adapter: 'openai', name: 'anthropic/claude-sonnet-4', ApiKey: 'orca-fixture-key', baseUrl: 'https://api.orcarouter.ai/v1' });
});
