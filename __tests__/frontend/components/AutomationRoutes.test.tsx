import { render, screen } from '@testing-library/react';

const mockWavesManager = jest.fn(({ height }: { height?: unknown }) => (
  <div data-testid="waves-manager" data-height={JSON.stringify(height)} />
));

jest.mock('@/frontend/components/PlannedExecutions', () => ({
  __esModule: true,
  default: () => <div data-testid="triggers-manager" />,
}));

jest.mock('@/frontend/components/Waves', () => ({
  __esModule: true,
  default: (props: { height?: unknown }) => mockWavesManager(props),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn() }),
}));

import ExecutionsPage from '@/app/executions/page';
import WavesPage from '@/app/waves/page';
import { WAVES_VIEWPORT_HEIGHT } from '@/app/waves/constants';
import AutomationTriggersPage from '@/app/automation/triggers/page';
import AutomationWavesPage from '@/app/automation/waves/page';

describe('Automation route composition (#325)', () => {
  beforeEach(() => {
    mockWavesManager.mockClear();
  });

  it('keeps legacy and Automation routes on the same screen implementations', () => {
    expect(AutomationTriggersPage).toBe(ExecutionsPage);
    expect(AutomationWavesPage).toBe(WavesPage);

    render(<AutomationTriggersPage />);
    expect(screen.getByTestId('triggers-manager')).toBeInTheDocument();
  });

  it('passes the responsive viewport height from the Waves route to its manager', () => {
    render(<AutomationWavesPage />);

    expect(screen.getByTestId('waves-manager')).toHaveAttribute(
      'data-height',
      JSON.stringify(WAVES_VIEWPORT_HEIGHT),
    );
    const lastManagerCall = mockWavesManager.mock.calls[mockWavesManager.mock.calls.length - 1];
    expect(lastManagerCall?.[0]).toEqual({
      height: {
        xs: 'calc(100dvh - 56px)',
        sm: 'calc(100dvh - 64px)',
      },
    });
  });
});
