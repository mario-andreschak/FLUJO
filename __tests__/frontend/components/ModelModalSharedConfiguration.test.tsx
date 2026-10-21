import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { Model } from '@/shared/types';

const mockRefresh = jest.fn(); const mockDiscover = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ globalEnvVars: {}, settings: {} }) }));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({ useAskFlujo: mockUseAskFlujo, useAskFlujoPage: mockUseAskFlujoPage }));
jest.mock('@/frontend/services/model', () => ({ modelService: { fetchProviderModels: (...args: unknown[]) => mockDiscover(...args) } }));
jest.mock('@/frontend/components/shared/PromptBuilder', () => ({ __esModule: true, default: () => <div>Private prompt builder</div> }));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({ __esModule: true, default: () => null }));
import ModelModal from '@/frontend/components/models/modal';

const model: Model = { id: 'shared-model', name: 'fixture-local', displayName: 'Shared model', provider: 'ollama', adapter: 'openai',
  ApiKey: '', baseUrl: 'http://127.0.0.1:11434/v1', promptTemplate: 'Shared prompt' };
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

it.each(['ollama', 'codex'] as const)('configuration editing for %s never discovers providers or offers credential fields', async provider => {
  jest.useFakeTimers();
  const save = jest.fn(async () => ({ success: true })); const draft = jest.fn();
  render(<ThemeProvider theme={createTheme()}><ModelModal open configurationOnly
    model={{ ...model, provider, adapter: provider === 'codex' ? 'codex-cli' : 'openai', ApiKey: 'must-not-be-used' }}
    onSave={save} onClose={jest.fn()} onDraftChange={draft} saveLabel="Save team revision" /></ThemeProvider>);
  await act(async () => { jest.advanceTimersByTime(61_000); });
  expect(mockDiscover).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.queryByText('Private prompt builder')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'Edited shared prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save team revision' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]).toEqual([expect.objectContaining({ ApiKey: '', promptTemplate: 'Edited shared prompt' })]);
  expect(draft).toHaveBeenLastCalledWith(expect.objectContaining({ ApiKey: '', promptTemplate: 'Edited shared prompt' }));
  expect(mockRefresh).not.toHaveBeenCalled();
});

it('a rejected shared save retains the editable draft and a lost lease disables both click and form submission', async () => {
  const save = jest.fn(async () => ({ success: false, error: 'The team lock ended.' }));
  const view = render(<ThemeProvider theme={createTheme()}><ModelModal open configurationOnly model={model} onSave={save} onClose={jest.fn()} /></ThemeProvider>);
  fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  expect(await screen.findByText('The team lock ended.')).toBeInTheDocument();
  expect(screen.getByLabelText('Prompt template')).toHaveValue('Keep this draft');
  view.rerender(<ThemeProvider theme={createTheme()}><ModelModal open configurationOnly model={model} onSave={save} onClose={jest.fn()} saveDisabled /></ThemeProvider>);
  const button = screen.getByRole('button', { name: /^Save$/ }); expect(button).toBeDisabled();
  fireEvent.submit(button.closest('form')!);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Prompt template')).toHaveValue('Keep this draft');
});
