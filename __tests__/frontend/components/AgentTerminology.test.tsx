import { render, screen, waitFor } from '@testing-library/react';

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: () => <div data-testid="flow-card" />,
  FlowCardSkeleton: () => <div data-testid="flow-card-skeleton" />,
}));

jest.mock('@/frontend/components/shared/BackToTopButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import FlowDashboard from '@/frontend/components/Flow/FlowDashboard/FlowDashboard';

describe('Agent product terminology', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(async () => ({
        ok: true,
        json: async () => [],
      })),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  it('calls saved flows Agents throughout the collection UI', async () => {
    render(
      <FlowDashboard
        flows={[]}
        selectedFlow={null}
        onSelectFlow={() => undefined}
        onDeleteFlow={() => undefined}
        onCreateFlow={() => undefined}
      />,
    );

    expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show agent cards' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show compact agent list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort agents' })).toBeInTheDocument();
    expect(screen.getByText('0 of 0 agents')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No agents yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create My First Agent' })).toBeInTheDocument();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  });
});
