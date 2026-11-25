/**
 * Settings → Experimental features → Context management → "Move large tool
 * results to a resource" (issue #1226).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ToolResultLimitSettings from '@/frontend/components/Settings/ToolResultLimitSettings';

type Values = {
  toolResultTruncationEnabled: boolean;
  toolResultLimitMode: 'auto' | 'custom';
  toolResultMaxBytes: number;
  toolResultMaxLines: number;
};

describe('ToolResultLimitSettings', () => {
  const originalFetch = global.fetch;
  let current: Values;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    current = { toolResultTruncationEnabled: false, toolResultLimitMode: 'auto', toolResultMaxBytes: 256 * 1024, toolResultMaxLines: 10_000 };
    fetchMock = jest.fn(async (input: string, init?: RequestInit) => {
      if (input !== '/api/tool-result-limit') throw new Error(`Unexpected fetch: ${input}`);
      if (init?.method === 'PATCH') current = { ...current, ...JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ settings: current }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    if (originalFetch) global.fetch = originalFetch;
    else delete (global as { fetch?: typeof fetch }).fetch;
  });

  const patches = () => fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init.body)));

  it('is off by default and explains the automatic size with real numbers', async () => {
    render(<ToolResultLimitSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Move large tool results to a resource' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/about 98 KB for a 200,000-token model, and 64 KB when the model does not state its window/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Automatic (based on the model)' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Size limit (KB)' })).toBeDisabled();
  });

  it('turns the limit on, switches to a custom size and saves it in bytes', async () => {
    render(<ToolResultLimitSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Move large tool results to a resource' }));
    await waitFor(() => expect(patches()).toEqual([{ toolResultTruncationEnabled: true }]));
    expect(await screen.findByText('Saved. The next tool call uses the new setting.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Custom size' }));
    await waitFor(() => expect(patches()).toContainEqual({ toolResultLimitMode: 'custom' }));

    const size = await screen.findByRole('spinbutton', { name: 'Size limit (KB)' });
    await waitFor(() => expect(size).toBeEnabled());
    fireEvent.change(size, { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(patches()).toContainEqual({ toolResultMaxBytes: 32 * 1024, toolResultMaxLines: 10_000 }));
  });

  it('refuses a size outside 1 to 102,400 KB before anything is sent', async () => {
    current = { ...current, toolResultTruncationEnabled: true, toolResultLimitMode: 'custom' };
    render(<ToolResultLimitSettings />);
    const size = await screen.findByRole('spinbutton', { name: 'Size limit (KB)' });
    fireEvent.change(size, { target: { value: '0' } });
    expect(screen.getByText('Enter a whole number of kilobytes from 1 to 102,400.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Line limit' }), { target: { value: '-1' } });
    expect(screen.getByText('Enter a whole number from 0 to 10,000,000.')).toBeInTheDocument();
    expect(patches()).toEqual([]);
  });

  it('says so when the setting cannot be loaded or saved', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({}) }));
    const { unmount } = render(<ToolResultLimitSettings />);
    expect(await screen.findByText('Could not load the tool result size limit.')).toBeInTheDocument();
    unmount();

    render(<ToolResultLimitSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Move large tool results to a resource' });
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: 'save-failed' }) }));
    fireEvent.click(toggle);
    expect(await screen.findByText('Could not save the tool result size limit. Try again.')).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });
});
