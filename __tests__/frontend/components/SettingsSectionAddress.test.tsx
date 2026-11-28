/**
 * Settings keeps the open section in the address (`/settings?section=users`).
 * Turning sign-in on or off reloads the page; before, the reload dropped the
 * person back on "Network access", away from what they had just changed.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import Settings from '@/frontend/components/Settings';

function mockSection(name: string) {
  return function Section() { return <p>{name} section body</p>; };
}
jest.mock('@/frontend/components/Settings/EncryptionSettings', () => mockSection('Encryption'));
jest.mock('@/frontend/components/Settings/ThemeSettings', () => mockSection('Theme'));
jest.mock('@/frontend/components/Settings/GlobalEnvSettings', () => mockSection('Global variables'));
jest.mock('@/frontend/components/Settings/BackupSettings', () => mockSection('Backup'));
jest.mock('@/frontend/components/Settings/SpeechRecognitionSettings', () => mockSection('Speech'));
jest.mock('@/frontend/components/Settings/UpdateSettings', () => mockSection('Updates'));
jest.mock('@/frontend/components/Settings/OnboardingSettings', () => mockSection('Onboarding'));
jest.mock('@/frontend/components/Settings/ExperimentalFeaturesSettings', () => mockSection('Advanced'));
jest.mock('@/frontend/components/Settings/PrivacySettings', () => mockSection('Privacy'));
jest.mock('@/frontend/components/Settings/ModelAccessSettings', () => mockSection('Model access'));
jest.mock('@/frontend/components/Settings/LanguageSettings', () => mockSection('Language'));
jest.mock('@/frontend/components/Settings/NetworkExposureSettings', () => mockSection('Network'));
jest.mock('@/frontend/components/Settings/RuntimeEnvironmentSettings', () => mockSection('Process environment'));
jest.mock('@/frontend/components/Settings/McpStartupSettings', () => mockSection('Tool server startup'));
jest.mock('@/frontend/components/Settings/ChatFilesSettings', () => mockSection('Chat files'));
jest.mock('@/frontend/components/Settings/UserAccountsSettings', () => mockSection('Users'));

function renderSettings(initialSection?: string) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <I18nProvider>
        <Settings initialSection={initialSection} />
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('Settings section in the address', () => {
  beforeEach(() => window.history.replaceState(null, '', '/settings'));

  it('opens the section the address names, so a reload keeps the person where they were', () => {
    renderSettings('users');
    expect(screen.getByRole('heading', { level: 2, name: 'Users and sign-in' })).toBeInTheDocument();
    expect(screen.getByText('Users section body')).toBeInTheDocument();
  });

  it('falls back to the first section for a missing or unknown name', () => {
    renderSettings('no-such-section');
    expect(screen.getByRole('heading', { level: 2, name: 'Network access' })).toBeInTheDocument();
  });

  it('writes the chosen section into the address without leaving the page', () => {
    renderSettings();
    fireEvent.click(screen.getAllByRole('button', { name: 'Users and sign-in' })[0]);
    expect(screen.getByRole('heading', { level: 2, name: 'Users and sign-in' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    expect(new URLSearchParams(window.location.search).get('section')).toBe('users');
  });
});
