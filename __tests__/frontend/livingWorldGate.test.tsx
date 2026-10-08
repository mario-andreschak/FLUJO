/** @jest-environment jsdom */

import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom';

import RiverWorld from '@/frontend/components/AmbientWorld/RiverWorld';
import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';

const mockTheme = {
  isDarkMode: false,
  livingWorldEnabled: true,
  themeHydrated: true,
  visualStyle: 'modern' as 'modern' | 'legacy',
};

jest.mock('next/navigation', () => ({
  usePathname: () => '/models',
}));

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => mockTheme,
}));

describe('Living Watershed theme preference', () => {
  afterEach(() => {
    cleanup();
    mockTheme.livingWorldEnabled = true;
    mockTheme.themeHydrated = true;
    mockTheme.visualStyle = 'modern';
    document.documentElement.classList.remove('living-world-active');
    delete document.documentElement.dataset.livingScene;
    document.documentElement.style.removeProperty('--river-scene-accent');
  });

  it('stays out of the UI until the theme has hydrated', () => {
    mockTheme.themeHydrated = false;

    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeNull();
    expect(document.documentElement).not.toHaveClass('living-world-active');
  });

  it('stays disabled when the landscape preference is off', () => {
    mockTheme.livingWorldEnabled = false;

    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeNull();
    expect(document.documentElement).not.toHaveClass('living-world-active');
  });

  it('keeps the legacy compatibility preset free of the new environment', () => {
    mockTheme.visualStyle = 'legacy';

    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeNull();
    expect(document.documentElement).not.toHaveClass('living-world-active');
  });

  it('mounts and identifies the route scene for the default-on Modern theme', () => {
    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeInTheDocument();
    const location = container.querySelector('.living-watershed__location');
    expect(location).toHaveAttribute('aria-hidden', 'true');
    expect(location).not.toHaveAttribute('aria-live');
    expect(document.documentElement).toHaveClass('living-world-active');
    expect(document.documentElement).toHaveAttribute('data-living-scene', 'models');
    expect(document.documentElement.style.getPropertyValue('--river-scene-accent')).toBe(flowNodeColors.dark.mcp);
  });
});
