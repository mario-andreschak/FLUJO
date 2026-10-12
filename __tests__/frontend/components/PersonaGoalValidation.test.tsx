/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import PersonaGoalDialog from '@/frontend/components/Personas/PersonaGoalDialog';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from '@/frontend/i18n/locales';
import { catalogs } from '@/frontend/i18n/messages';

beforeEach(() => window.localStorage.clear());

it.each(SUPPORTED_LOCALES)('explains invalid goal limits in $code and allows correction', ({ code }) => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, code);
  const catalog = catalogs[code];
  render(<I18nProvider><PersonaGoalDialog open personaId="persona" busy={false} mutate={jest.fn()} onClose={jest.fn()} /></I18nProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: new RegExp(catalog['personas.goal.field.goal']) }), { target: { value: 'Reach more people' } });
  const start = screen.getByRole('button', { name: catalog['personas.goal.start'] });
  expect(start).toBeEnabled();
  fireEvent.click(screen.getByText(catalog['personas.goal.continuationControls']));

  const checks = [
    { label: 'personas.goal.cadence', message: 'personas.goal.cadenceInvalid', bad: '604801', good: '60' },
    { label: 'personas.goal.dailyLimit', message: 'personas.goal.dailyLimitInvalid', bad: '1.5', good: '' },
    { label: 'personas.goal.maxRounds', message: 'personas.goal.maxRoundsInvalid', bad: '0', good: '' },
  ] as const;
  for (const check of checks) {
    const field = screen.getByRole('spinbutton', { name: catalog[check.label] });
    fireEvent.change(field, { target: { value: check.bad } });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(catalog[check.message]);
    expect(start).toBeDisabled();
    fireEvent.change(field, { target: { value: check.good } });
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(start).toBeEnabled();
  }
});
