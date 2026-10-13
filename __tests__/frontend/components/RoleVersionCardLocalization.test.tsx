/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import RoleVersionCard from '@/frontend/components/Personas/RoleVersionCard';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY, type SupportedLocale } from '@/frontend/i18n/locales';
import type { RoleVersion } from '@/shared/types/enduringAgent';

const copy: [SupportedLocale, string, string, string[]][] = [
  ['en', 'Immutable', 'Version 3', ['0 behavior slots', '1 behavior slot', '2 behavior slots']],
  ['es', 'Inmutable', 'Versión 3', ['0 espacios de comportamiento', '1 espacio de comportamiento', '2 espacios de comportamiento']],
  ['de', 'Unveränderlich', 'Version 3', ['0 Verhaltensplätze', '1 Verhaltensplatz', '2 Verhaltensplätze']],
  ['fr', 'Immuable', 'Version 3', ['0 emplacement de comportement', '1 emplacement de comportement', '2 emplacements de comportement']],
  ['it', 'Immutabile', 'Versione 3', ['0 slot di comportamento', '1 slot di comportamento', '2 slot di comportamento']],
  ['pt', 'Imutável', 'Versão 3', ['0 espaço de comportamento', '1 espaço de comportamento', '2 espaços de comportamento']],
  ['zh-CN', '不可变', '版本 3', ['0 个行为槽', '1 个行为槽', '2 个行为槽']],
];

function role(count: number): RoleVersion {
  return {
    schemaVersion: 3, id: 'saved-role-version', roleDefinitionId: 'authored-role', version: 3,
    name: 'User-authored Role', mission: 'Keep this authored mission unchanged.', createdAt: 1,
    behaviorSlots: Array.from({ length: count }, (_, index) => ({
      key: `behavior-${index}`, name: `Authored behavior ${index}`,
      flowTemplate: { id: `flow-${index}`, name: `Authored flow ${index}`, nodes: [], edges: [] },
    })),
  };
}

beforeEach(() => window.localStorage.clear());

it('leaves display-only cards out of the button and Tab navigation contract', () => {
  const { container } = render(<I18nProvider><RoleVersionCard role={role(1)} plainLanguage /></I18nProvider>);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(container.querySelector('[tabindex="0"]')).toBeNull();
});

it('keeps a standalone selectable card keyboard accessible', () => {
  const onSelect = jest.fn();
  render(<I18nProvider><RoleVersionCard role={role(1)} onSelect={onSelect} /></I18nProvider>);
  const button = screen.getByRole('button');
  expect(button).toHaveAttribute('tabindex', '0');
  fireEvent.click(button);
  expect(onSelect).toHaveBeenCalledWith('saved-role-version');
});

describe.each(copy)('Role Version metadata in %s', (locale, immutable, version, counts) => {
  it.each([0, 1, 2])('localizes a card with %i behavior slots through the real locale provider', count => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const authored = role(count);
    const original = JSON.stringify(authored);
    render(<I18nProvider><RoleVersionCard role={authored} /></I18nProvider>);

    expect(screen.getByText(immutable)).toBeInTheDocument();
    expect(screen.getByText(version)).toBeInTheDocument();
    expect(screen.getByText(counts[count])).toBeInTheDocument();
    expect(screen.getByText(authored.name)).toBeInTheDocument();
    expect(screen.getByText(authored.mission)).toBeInTheDocument();
    expect(JSON.stringify(authored)).toBe(original);
  });

  it('keeps advanced metadata hidden in the plain-language card', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    render(<I18nProvider><RoleVersionCard role={role(2)} plainLanguage /></I18nProvider>);
    expect(screen.queryByText(immutable)).not.toBeInTheDocument();
    expect(screen.queryByText(version)).not.toBeInTheDocument();
    expect(screen.queryByText(counts[2])).not.toBeInTheDocument();
    expect(screen.getByText('User-authored Role')).toBeInTheDocument();
  });
});
