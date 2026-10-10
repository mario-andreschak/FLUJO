/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import PersonaAppToolsDialog from '@/frontend/components/Personas/PersonaAppToolsDialog';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from '@/frontend/i18n/locales';
import { catalogs } from '@/frontend/i18n/messages';

jest.mock('@/frontend/hooks/useServerTools', () => ({
  useServerTools: () => ({ tools: [], toolsServerName: 'Calendar', isLoading: false, error: null, retryLoadTools: jest.fn() }),
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/MCPNodeToolList', () => ({
  __esModule: true, default: () => <div>Authored tools</div>,
}));

beforeEach(() => window.localStorage.clear());

it.each(SUPPORTED_LOCALES)('announces App permissions and missing picker help in $code', ({ code }) => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, code);
  render(<I18nProvider>
    <PersonaAppToolsDialog open grant={{
      schemaVersion: 1, id: 'grant', personaId: 'persona', mcpServerName: 'Calendar', createdAt: 1, updatedAt: 1,
    }} busy={false} onClose={jest.fn()} onSave={jest.fn()} />
    <CardPickerGrid items={[{ key: 'missing', content: <div>Authored app</div>, missing: true, onRepair: jest.fn() }]} />
  </I18nProvider>);
  const catalog = catalogs[code];
  const dialog = screen.getByRole('dialog', { name: catalog['personas.apps.toolsTitle'].replace('{server}', 'Calendar') });
  expect(dialog).toHaveAccessibleDescription(catalog['personas.apps.toolsHelp']);
  // Read the picker outside the modal because MUI correctly hides its siblings
  // from the accessibility tree while the modal is open.
  expect(screen.getByText(catalog['cardPicker.missing'])).toBeInTheDocument();
  expect(screen.getByRole('button', { name: catalog['cardPicker.repair'], hidden: true })).toBeInTheDocument();
  expect(Object.hasOwn(catalog, 'cardPicker.missing')).toBe(true);
  expect(Object.hasOwn(catalog, 'cardPicker.repair')).toBe(true);
});
