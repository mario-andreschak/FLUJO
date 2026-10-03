import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FallbackPolicyDialog from '@/frontend/components/models/FallbackPolicyDialog';
import { translate } from '@/frontend/i18n/core';
import type { Model } from '@/shared/types/model';
import { modelService } from '@/frontend/services/model';

jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: never) => translate('en', key) }) }));

const models: Model[] = [
  { id: 'a', name: 'primary', displayName: 'OpenAI primary', ApiKey: '' },
  { id: 'b', name: 'backup', displayName: 'Anthropic backup', ApiKey: '' },
];
const policy: Model = { id: 'p', name: 'policy/production', displayName: 'Production', ApiKey: '', fallbackPolicy: { modelIds: ['a', 'b'] } };

it('reorders members, edits triggers, and saves a credential-free policy', async () => {
  const save = jest.fn(async () => ({ success: true }));
  render(<FallbackPolicyDialog model={policy} models={models} onSave={save} onClose={jest.fn()} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Move model down' })[0]);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Provider timeout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]).toEqual([expect.objectContaining({
    ApiKey: '', name: 'policy/production', fallbackPolicy: {
      modelIds: ['b', 'a'], triggers: ['rate_limit', 'unavailable'], cooldownSeconds: 60,
    },
  })]);
});

it('requires a primary plus a backup and preserves the draft on a save error', async () => {
  const save = jest.fn(async () => ({ success: false, error: 'Workspace save failed' }));
  render(<FallbackPolicyDialog model={policy} models={models} onSave={save} onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Workspace save failed');
  expect(screen.getByRole('textbox', { name: 'API alias' })).toHaveValue('production');
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove model' })[1]);
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

it('shows a useful error for an invalid stable alias', async () => {
  const save = jest.fn();
  render(<FallbackPolicyDialog model={policy} models={models} onSave={save} onClose={jest.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'API alias' }), { target: { value: 'Invalid alias' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText(/Policy alias must be/)).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it('submits a provider-free policy through the real frontend service', async () => {
  const previousFetch = global.fetch;
  const fetchMock = jest.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => ({
    ok: true, status: 201, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => policy,
  } as Response));
  global.fetch = fetchMock;
  try {
    render(<FallbackPolicyDialog model={policy} models={models}
      onSave={draft => modelService.addModel(draft)} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/model', expect.objectContaining({ method: 'POST' })));
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).toMatchObject({ name: 'policy/production', ApiKey: '', fallbackPolicy: { modelIds: ['a', 'b'] } });
    expect(screen.queryByText('Provider is required')).not.toBeInTheDocument();
  } finally {
    global.fetch = previousFetch;
  }
});
