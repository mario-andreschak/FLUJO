/**
 * Component tests for the presentational ScrollNavCluster (issue #376).
 *
 * The cluster replaces the old BackToTopButton and is fully prop-driven, so it
 * is verified in isolation: which buttons render, their i18n labels, the
 * disabled ends (which is what keeps the controls reachable from the default
 * bottom position) and the positioning mode.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ScrollNavCluster from '@/frontend/components/shared/ScrollNavCluster';

const actionsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-nav-action]')).map(el =>
    el.getAttribute('data-scroll-nav-action'),
  );

describe('ScrollNavCluster (#376)', () => {
  it('renders exactly the requested actions, in order', () => {
    const { container } = render(
      <ScrollNavCluster actions={['top', 'up', 'down', 'bottom']} onAction={jest.fn()} />,
    );

    expect(actionsOf(container)).toEqual(['top', 'up', 'down', 'bottom']);
  });

  it('renders a trimmed action list for surfaces without groups', () => {
    const { container } = render(<ScrollNavCluster actions={['top', 'bottom']} onAction={jest.fn()} />);

    expect(actionsOf(container)).toEqual(['top', 'bottom']);
  });

  it('renders nothing while hidden', () => {
    const { container } = render(<ScrollNavCluster show={false} onAction={jest.fn()} />);

    expect(actionsOf(container)).toEqual([]);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('labels every button from the shared i18n catalog', () => {
    render(<ScrollNavCluster actions={['top', 'up', 'down', 'bottom']} onAction={jest.fn()} />);

    expect(screen.getByRole('group', { name: 'Scroll navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll to top' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll down' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('honours per-action label overrides (folder navigation, chat wording)', () => {
    render(
      <ScrollNavCluster
        actions={['up', 'down']}
        labels={{ up: 'Previous folder', down: 'Next folder' }}
        onAction={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Previous folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next folder' })).toBeInTheDocument();
  });

  it('reports the clicked action exactly once', () => {
    const onAction = jest.fn();
    render(<ScrollNavCluster actions={['top', 'bottom']} onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to top' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('top');
  });

  it('renders disabled ends but does not report them (still reachable, never a no-op click)', () => {
    const onAction = jest.fn();
    const { container } = render(
      <ScrollNavCluster
        actions={['top', 'up', 'down', 'bottom']}
        disabled={{ top: true, bottom: true }}
        onAction={onAction}
      />,
    );

    // Every control is still on screen — this is the reachability fix.
    expect(actionsOf(container)).toEqual(['top', 'up', 'down', 'bottom']);

    const top = screen.getByRole('button', { name: 'Scroll to top' });
    expect(top).toBeDisabled();
    fireEvent.click(top);
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Scroll down' }));
    expect(onAction).toHaveBeenCalledWith('down');
  });

  it('supports fixed (window pages) and absolute (chat overlay) positioning', () => {
    const { unmount } = render(<ScrollNavCluster actions={['top']} onAction={jest.fn()} />);
    expect(screen.getByRole('group')).toHaveStyle({ position: 'fixed' });
    unmount();

    render(<ScrollNavCluster actions={['top']} positionMode="absolute" onAction={jest.fn()} />);
    expect(screen.getByRole('group')).toHaveStyle({ position: 'absolute' });
  });
});
