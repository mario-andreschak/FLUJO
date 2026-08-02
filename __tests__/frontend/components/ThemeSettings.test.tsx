import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ThemeSettings from '@/frontend/components/Settings/ThemeSettings';

const setThemePreset = jest.fn();
const setLivingWorldEnabled = jest.fn();

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({
    isDarkMode: false,
    livingWorldEnabled: true,
    themeHydrated: true,
    visualStyle: 'modern',
    toggleTheme: jest.fn(),
    setVisualStyle: jest.fn(),
    setLivingWorldEnabled,
    setThemePreset,
  }),
}));

describe('ThemeSettings', () => {
  beforeEach(() => {
    setThemePreset.mockClear();
    setLivingWorldEnabled.mockClear();
  });

  it('offers all four complete visual presets', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <ThemeSettings />
      </ThemeProvider>,
    );

    expect(screen.getByRole('radio', { name: 'Modern Light' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Modern Dark' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Legacy Light' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Legacy Dark' })).toBeInTheDocument();
  });

  it('selects style and mode together', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <ThemeSettings />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Legacy Dark' }));
    expect(setThemePreset).toHaveBeenCalledWith({ style: 'legacy', mode: 'dark' });
  });

  it('offers a default-on animated landscape preference', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <ThemeSettings />
      </ThemeProvider>,
    );

    const landscape = screen.getByRole('checkbox', { name: 'Animated landscape' });
    expect(landscape).toBeChecked();

    fireEvent.click(landscape);
    expect(setLivingWorldEnabled).toHaveBeenCalledWith(false);
  });
});
