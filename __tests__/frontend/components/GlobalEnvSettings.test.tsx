/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';

const setGlobalEnvVarsMock = jest.fn();
jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    globalEnvVars: {},
    setGlobalEnvVars: (...args: unknown[]) => setGlobalEnvVarsMock(...args),
    deleteGlobalEnvVar: jest.fn(),
  }),
}));
jest.mock('@/frontend/components/mcp/MCPEnvManager/EnvEditor', () => ({
  __esModule: true,
  default: ({ onSave }: { onSave: (env: Record<string, string>) => Promise<void> }) => (
    <button type="button" onClick={() => void onSave({ API_URL: 'https://example.test' })}>Save variables</button>
  ),
}));

import GlobalEnvSettings from '@/frontend/components/Settings/GlobalEnvSettings';

const SAVED = 'Global environment variables updated successfully.';
const FAILED = 'Failed to update global environment variables.';

beforeEach(() => {
  jest.useFakeTimers();
  setGlobalEnvVarsMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save variables' }));
  });
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

it('shows the saved message and hides it after 3 seconds', async () => {
  render(<GlobalEnvSettings />);
  await save();
  expect(setGlobalEnvVarsMock).toHaveBeenCalledWith({ API_URL: 'https://example.test' });
  expect(screen.getByText(SAVED)).toBeInTheDocument();

  advance(2999);
  expect(screen.getByText(SAVED)).toBeInTheDocument();
  advance(1);
  expect(screen.queryByText(SAVED)).not.toBeInTheDocument();
});

it('starts the 3 seconds again when the user saves again', async () => {
  render(<GlobalEnvSettings />);
  await save();
  advance(2000);
  await save();

  advance(2000);
  expect(screen.getByText(SAVED)).toBeInTheDocument();
  advance(1000);
  expect(screen.queryByText(SAVED)).not.toBeInTheDocument();
});

it('keeps an error message until the next save, even when it follows a success', async () => {
  render(<GlobalEnvSettings />);
  await save();
  setGlobalEnvVarsMock.mockRejectedValue(new Error('disk full'));
  advance(2000);
  await save();
  expect(screen.getByText(FAILED)).toBeInTheDocument();

  advance(10_000);
  expect(screen.getByText(FAILED)).toBeInTheDocument();
  expect(jest.getTimerCount()).toBe(0);
});
