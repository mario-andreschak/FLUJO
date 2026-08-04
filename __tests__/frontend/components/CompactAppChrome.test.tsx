import { fireEvent, render, screen } from '@testing-library/react';
import useCompactAppChrome from '@/frontend/hooks/useCompactAppChrome';

let mockPathname = '/models';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

function Harness() {
  useCompactAppChrome();
  return (
    <main id="main-content">
      <div data-testid="scroller">content</div>
    </main>
  );
}

describe('compact app chrome', () => {
  beforeEach(() => {
    mockPathname = '/models';
    document.documentElement.classList.remove('app-chrome-condensed');
  });

  afterEach(() => {
    document.documentElement.classList.remove('app-chrome-condensed');
  });

  it('condenses on workspace scroll and expands again near the top', () => {
    render(<Harness />);
    const scroller = screen.getByTestId('scroller');

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 120 });
    fireEvent.scroll(scroller);
    expect(document.documentElement).toHaveClass('app-chrome-condensed');

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 12 });
    fireEvent.scroll(scroller);
    expect(document.documentElement).not.toHaveClass('app-chrome-condensed');
  });

  it('does not alter the chrome on pages outside the compact workspace set', () => {
    mockPathname = '/settings';
    render(<Harness />);
    const scroller = screen.getByTestId('scroller');

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 120 });
    fireEvent.scroll(scroller);
    expect(document.documentElement).not.toHaveClass('app-chrome-condensed');
  });

  it('cleans up the condensed state when leaving the workspace', () => {
    const { unmount } = render(<Harness />);
    const scroller = screen.getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 120 });
    fireEvent.scroll(scroller);
    expect(document.documentElement).toHaveClass('app-chrome-condensed');

    unmount();
    expect(document.documentElement).not.toHaveClass('app-chrome-condensed');
  });
});
