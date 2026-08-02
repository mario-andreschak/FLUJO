/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createAppTheme, createLegacyAppTheme, getThemeOptions } from '@/frontend/utils/muiTheme';
import { legacyThemeColors, themeColors } from '@/frontend/utils/paletteTokens';
import { ThemeProvider, useTheme } from '@/frontend/contexts/ThemeContext';
import { loadItem, saveItem, StorageKey } from '@/utils/storage';

jest.mock('@/utils/storage', () => ({
  ...jest.requireActual('@/shared/types/storage'),
  loadItem: jest.fn(),
  saveItem: jest.fn().mockResolvedValue(undefined),
}));

const mockedLoadItem = loadItem as jest.MockedFunction<typeof loadItem>;
const mockedSaveItem = saveItem as jest.MockedFunction<typeof saveItem>;

function ThemeProbe() {
  const {
    isDarkMode,
    livingWorldEnabled,
    themeHydrated,
    visualStyle,
    toggleTheme,
    setVisualStyle,
    setLivingWorldEnabled,
    setThemePreset,
  } = useTheme();
  return (
    <div>
      <output>{`${visualStyle}/${isDarkMode ? 'dark' : 'light'}`}</output>
      <output aria-label="Landscape preference">{`${themeHydrated}/${livingWorldEnabled}`}</output>
      <button onClick={toggleTheme}>Toggle mode</button>
      <button onClick={() => setVisualStyle('modern')}>Use modern</button>
      <button onClick={() => setLivingWorldEnabled(false)}>Disable landscape</button>
      <button onClick={() => setThemePreset({ mode: 'dark', style: 'modern' })}>Modern dark</button>
    </div>
  );
}

describe('four visual theme presets', () => {
  it('keeps modern as the default and reconstructs both legacy palettes', () => {
    expect(getThemeOptions('light').palette.background.default).toBe(themeColors.light.background);
    expect(getThemeOptions('dark', 'modern').palette.background.default).toBe(themeColors.dark.background);
    expect(getThemeOptions('light', 'legacy').palette.background.default).toBe(legacyThemeColors.light.background);
    expect(getThemeOptions('dark', 'legacy').palette.background.default).toBe(legacyThemeColors.dark.background);
  });

  it('keeps the public modern builder and the dedicated legacy builder distinct', () => {
    expect(createAppTheme('light').palette.primary.main).toBe('#6355E8');
    expect(createLegacyAppTheme('light').palette.primary.main).toBe('#007bff');
    expect(createAppTheme('dark').shape.borderRadius).toBe(14);
    expect(createLegacyAppTheme('dark').shape.borderRadius).toBe(4);
  });
});

describe('ThemeProvider persistence compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSaveItem.mockResolvedValue(undefined);
    mockedLoadItem.mockImplementation(async (key, defaultValue) => {
      if (key === StorageKey.THEME) return 'dark' as typeof defaultValue;
      if (key === StorageKey.THEME_STYLE) return 'legacy' as typeof defaultValue;
      return defaultValue;
    });
  });

  it('loads mode and style independently and exposes the style on the root', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await screen.findByText('legacy/dark');
    expect(document.documentElement).toHaveAttribute('data-visual-style', 'legacy');
    expect(document.documentElement).toHaveClass('legacy-theme', 'dark-theme');

    fireEvent.click(screen.getByRole('button', { name: 'Toggle mode' }));
    await screen.findByText('legacy/light');
    expect(mockedSaveItem).toHaveBeenCalledWith(StorageKey.THEME, 'light');
    expect(document.documentElement).toHaveAttribute('data-visual-style', 'legacy');
  });

  it('updates both preferences when a complete preset is selected', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    await screen.findByText('legacy/dark');

    fireEvent.click(screen.getByRole('button', { name: 'Modern dark' }));

    await screen.findByText('modern/dark');
    await waitFor(() => {
      expect(mockedSaveItem).toHaveBeenCalledWith(StorageKey.THEME, 'dark');
      expect(mockedSaveItem).toHaveBeenCalledWith(StorageKey.THEME_STYLE, 'modern');
    });
    expect(document.documentElement).toHaveAttribute('data-visual-style', 'modern');
    expect(document.documentElement).toHaveClass('modern-theme', 'dark-theme');
    expect(document.documentElement).not.toHaveClass('legacy-theme');
  });

  it('defaults the animated landscape on and persists an explicit off choice', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await screen.findByText('true/true');
    expect(mockedLoadItem).toHaveBeenCalledWith(StorageKey.LIVING_WORLD_ENABLED, true);

    fireEvent.click(screen.getByRole('button', { name: 'Disable landscape' }));
    await screen.findByText('true/false');
    expect(mockedSaveItem).toHaveBeenCalledWith(StorageKey.LIVING_WORLD_ENABLED, false);
  });

  it('restores an explicitly disabled animated landscape', async () => {
    mockedLoadItem.mockImplementation(async (key, defaultValue) => {
      if (key === StorageKey.LIVING_WORLD_ENABLED) return false as typeof defaultValue;
      return defaultValue;
    });

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await screen.findByText('true/false');
  });
});
