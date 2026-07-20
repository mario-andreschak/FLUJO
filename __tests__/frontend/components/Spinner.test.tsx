/**
 * Smoke render test proving the jsdom project works end-to-end (issue #176):
 * SWC transform of TSX, the "@/" alias, MUI rendering under jsdom, and the
 * @testing-library/jest-dom matchers. Spinner is purely presentational (all
 * props optional, no hooks/state/backend) with built-in accessibility.
 */
import { render, screen } from '@testing-library/react';
import Spinner from '@/frontend/components/shared/Spinner';

describe('Spinner', () => {
  it('renders a status role and an accessible loading label', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
