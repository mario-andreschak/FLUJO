import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import StickySearchBar from '@/frontend/components/shared/StickySearchBar';

describe('StickySearchBar', () => {
  it('renders its children', () => {
    render(
      <StickySearchBar>
        <div data-testid="child">hello</div>
      </StickySearchBar>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('sticks to the top of its scroll container in "container" mode (default)', () => {
    render(
      <StickySearchBar>
        <div data-testid="child" />
      </StickySearchBar>,
    );
    const wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(wrapper).toHaveStyle({ position: 'sticky', top: '0px' });
  });

  it('offsets by the app-bar/subnav height tokens in "page" mode', () => {
    render(
      <StickySearchBar mode="page">
        <div data-testid="child" />
      </StickySearchBar>,
    );
    const wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(wrapper).toHaveStyle({
      position: 'sticky',
      top: 'calc(var(--app-bar-height) + var(--active-subnav-height))',
    });
  });

  it('adds an extra numeric offset on top of the computed page offset', () => {
    render(
      <StickySearchBar mode="page" offset={16}>
        <div data-testid="child" />
      </StickySearchBar>,
    );
    const wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(wrapper).toHaveStyle({
      top: 'calc(calc(var(--app-bar-height) + var(--active-subnav-height)) + 16px)',
    });
  });

  it('adds a string offset on top of the container (0px) base', () => {
    render(
      <StickySearchBar mode="container" offset="8px">
        <div data-testid="child" />
      </StickySearchBar>,
    );
    const wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(wrapper).toHaveStyle({ top: 'calc(0px + 8px)' });
  });

  it('renders a plain, non-sticky wrapper when disableSticky is set', () => {
    render(
      <StickySearchBar disableSticky>
        <div data-testid="child" />
      </StickySearchBar>,
    );
    const wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(wrapper).not.toHaveStyle({ position: 'sticky' });
  });

  it('uses an opaque background so scrolled content cannot bleed through', () => {
    const { rerender } = render(
      <StickySearchBar mode="container">
        <div data-testid="child" />
      </StickySearchBar>,
    );
    let wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(getComputedStyle(wrapper).backgroundColor).not.toBe('');

    rerender(
      <StickySearchBar mode="page">
        <div data-testid="child" />
      </StickySearchBar>,
    );
    wrapper = screen.getByTestId('child').parentElement as HTMLElement;
    expect(getComputedStyle(wrapper).backgroundColor).not.toBe('');
  });
});
