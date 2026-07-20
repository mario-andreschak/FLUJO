/**
 * Component tests for the presentational BackToTopButton (issue #185).
 *
 * The button is purely prop-driven (visibility + click handler) so its
 * behaviour is deterministically checkable under jsdom; the scroll wiring lives
 * in the useScrollRestoration hook and is exercised separately / in the browser.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import BackToTopButton from '@/frontend/components/shared/BackToTopButton';

describe('BackToTopButton (#185)', () => {
  it('is not rendered when show is false', () => {
    render(<BackToTopButton show={false} onClick={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();
  });

  it('renders an accessible button when show is true', () => {
    render(<BackToTopButton show onClick={jest.fn()} />);
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = jest.fn();
    render(<BackToTopButton show onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /back to top/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
