/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { getContrastRatio, type CSSObject } from '@mui/material/styles';
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
  it.each([
    ['modern', 'light'], ['modern', 'dark'], ['legacy', 'light'], ['legacy', 'dark'],
  ] as const)('keeps supporting text and small status labels readable in %s %s', (style, mode) => {
    const theme = getThemeOptions(mode, style);
    for (const surface of [theme.palette.background.default, theme.palette.background.paper]) {
      expect(getContrastRatio(theme.palette.text.primary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(theme.palette.text.secondary, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ['secondary', 'info', 'success', 'warning', 'error'] as const) {
      const color = theme.palette[name];
      expect(getContrastRatio(color.contrastText, color.main)).toBeGreaterThanOrEqual(4.5);
      // These foregrounds also label contained buttons. Their darker hover
      // surfaces must retain the same contrast as the filled status chips.
      if ((style === 'legacy' && (name === 'info' || name === 'success'))
        || (style === 'modern' && (name === 'secondary' || name === 'warning'))) {
        expect(getContrastRatio(color.contrastText, color.dark)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each([
    ['modern', 'light'], ['modern', 'dark'], ['legacy', 'light'], ['legacy', 'dark'],
  ] as const)('keeps small primary labels readable in %s %s, including hover gradients', (style, mode) => {
    const theme = getThemeOptions(mode, style);
    const { primary } = theme.palette;
    expect(getContrastRatio(primary.contrastText, primary.main)).toBeGreaterThanOrEqual(4.5);
    if (style === 'legacy') {
      expect(getContrastRatio(primary.contrastText, primary.dark)).toBeGreaterThanOrEqual(4.5);
      return;
    }
    const button = theme.components!.MuiButton!.styleOverrides!.containedPrimary as CSSObject;
    const hover = button['&:hover'] as CSSObject;
    for (const state of [button, hover]) {
      expect(getContrastRatio(String(button.color), String(state.backgroundColor))).toBeGreaterThanOrEqual(4.5);
      const stops = String(state.backgroundImage).match(/#[\da-f]{6}/gi)!;
      expect(stops).toHaveLength(3);
      for (const stop of stops) {
        expect(getContrastRatio(String(button.color), stop)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps small filled success labels readable in the modern light theme', () => {
    const { success } = createAppTheme('light').palette;
    expect(getContrastRatio(success.contrastText, success.main)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps modern as the default and reconstructs both legacy palettes', () => {
    expect(getThemeOptions('light').palette.background.default).toBe(themeColors.light.background);
    expect(getThemeOptions('dark', 'modern').palette.background.default).toBe(themeColors.dark.background);
    expect(getThemeOptions('light', 'legacy').palette.background.default).toBe(legacyThemeColors.light.background);
    expect(getThemeOptions('dark', 'legacy').palette.background.default).toBe(legacyThemeColors.dark.background);
  });

  it('keeps the public modern builder and the dedicated legacy builder distinct', () => {
    expect(createAppTheme('light').palette.primary.main).toBe('#6355E8');
    expect(createLegacyAppTheme('light').palette.primary.main).toBe('#0069d9');
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
