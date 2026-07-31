/** @jest-environment jsdom */

import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom';

import RiverWorld from '@/frontend/components/AmbientWorld/RiverWorld';
import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';

const mockStorage = {
  settings: { experimental: { enabled: false } },
  settingsHydrated: true,
};

const mockTheme = {
  isDarkMode: false,
  visualStyle: 'modern' as 'modern' | 'legacy',
};

jest.mock('next/navigation', () => ({
  usePathname: () => '/models',
}));

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorage,
}));

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => mockTheme,
}));

describe('Living Watershed experimental gate', () => {
  afterEach(() => {
    cleanup();
    mockStorage.settings.experimental.enabled = false;
    mockStorage.settingsHydrated = true;
    mockTheme.visualStyle = 'modern';
    document.documentElement.classList.remove('living-world-active');
    delete document.documentElement.dataset.livingScene;
    document.documentElement.style.removeProperty('--river-scene-accent');
  });

  it('stays out of the UI until settings have hydrated', () => {
    mockStorage.settings.experimental.enabled = true;
    mockStorage.settingsHydrated = false;

    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeNull();
    expect(document.documentElement).not.toHaveClass('living-world-active');
  });

  it('stays disabled with the experimental master switch off', () => {
    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeNull();
    expect(document.documentElement).not.toHaveClass('living-world-active');
  });

  it('keeps the legacy compatibility preset free of the new environment', () => {
    mockStorage.settings.experimental.enabled = true;
    mockTheme.visualStyle = 'legacy';

    const { container } = render(<RiverWorld />);

    expect(container.querySelector('[data-living-world]')).toBeNull();
    expect(document.documentElement).not.toHaveClass('living-world-active');
  });

  it('mounts and identifies the route scene only for modern experimental UI', () => {
    mockStorage.settings.experimental.enabled = true;

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
