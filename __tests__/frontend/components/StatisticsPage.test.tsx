import { render, screen } from '@testing-library/react';

jest.mock('@/frontend/components/Statistics', () => ({
  __esModule: true,
  default: () => <div>Statistics dashboard content</div>,
}));

import StatisticsPage from '@/app/statistics/page';

describe('Statistics page', () => {
  it('shows the dashboard without any switch (#1449)', () => {
    render(<StatisticsPage />);

    expect(screen.getByText('Statistics dashboard content')).toBeInTheDocument();
  });
});
