/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RoleEditor from '@/frontend/components/Roles/RoleEditor';
import { I18nProvider, useI18n } from '@/frontend/contexts/I18nContext';
import { catalogs } from '@/frontend/i18n/messages';
import { LOCALE_STORAGE_KEY, type SupportedLocale } from '@/frontend/i18n/locales';
import { RolesApiError, rolesService } from '@/frontend/services/roles';
import type { PublicRole } from '@/shared/types/enduringAgent';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));
jest.mock('@/frontend/components/shared/CardPickerDialog', () => ({
  __esModule: true,
  default: ({ open, items, onClose }: { open: boolean; items: { key: string; label: string; selected: boolean; onSelect: () => void }[]; onClose: () => void }) => open ? (
    <div role="dialog" aria-label="Role Apps">
      {items.map(item => <input key={item.key} type="checkbox" aria-label={item.label} checked={item.selected} onChange={item.onSelect} />)}
      <button onClick={onClose}>Close Apps</button>
    </div>
  ) : null,
}));
jest.mock('@/frontend/components/mcp/useMcpAppsDiscovery', () => ({ useMcpAppsDiscovery: () => ({ servers: [{ name: 'Draft App', apps: [] }], loading: false, error: null }) }));
jest.mock('@/frontend/services/roles', () => ({
  ...jest.requireActual('@/frontend/services/roles'),
  rolesService: { get: jest.fn(), create: jest.fn(), update: jest.fn() },
}));

const role = { id: 'authored-role', name: 'Authored name', prompt: 'Authored instructions', currentVersionId: 'version-1', suggestedApps: [] } as unknown as PublicRole;
const locales: SupportedLocale[] = ['en', 'es', 'de', 'fr', 'it', 'pt', 'zh-CN'];

beforeEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

it.each(locales)('names actual loading feedback in %s', async (locale) => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  let finish!: (value: PublicRole) => void;
  jest.mocked(rolesService.get).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<I18nProvider><RoleEditor mode="edit" roleId={role.id} /></I18nProvider>);
  expect(await screen.findByRole('progressbar', { name: catalogs[locale]['roles.loading'] })).toBeInTheDocument();
  await act(async () => finish(role));
  expect(await screen.findByRole('textbox', { name: catalogs[locale]['roles.name'] })).toHaveValue(role.name);
});

function LocaleSwitch({ locale }: { locale: SupportedLocale }) {
  const { setLocale } = useI18n();
  return <button onClick={() => setLocale(locale)}>Switch language</button>;
}

it.each(locales.filter(locale => locale !== 'en'))('keeps unsaved fields, App choices and the stale version when a conflict is translated into %s', async (locale) => {
  const changedElsewhere = { ...role, name: 'Other-window name', prompt: 'Other-window instructions', currentVersionId: 'version-2' };
  jest.mocked(rolesService.get).mockResolvedValueOnce(role).mockResolvedValue(changedElsewhere);
  jest.mocked(rolesService.update).mockRejectedValue(new RolesApiError(409, 'Role changed elsewhere'));
  render(<I18nProvider><LocaleSwitch locale={locale} /><RoleEditor mode="edit" roleId={role.id} /></I18nProvider>);
  fireEvent.change(await screen.findByRole('textbox', { name: catalogs.en['roles.name'] }), { target: { value: 'Unsaved name' } });
  fireEvent.change(screen.getByRole('textbox', { name: catalogs.en['roles.prompt'] }), { target: { value: 'Unsaved instructions' } });
  fireEvent.click(screen.getByRole('button', { name: catalogs.en['roles.chooseApps'] }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Draft App' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close Apps' }));
  fireEvent.click(screen.getByRole('button', { name: catalogs.en['roles.save'] }));
  expect(await screen.findByText(catalogs.en['roles.changed'])).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch language' }));
  expect(await screen.findByText(catalogs[locale]['roles.changed'])).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: catalogs[locale]['roles.name'] })).toHaveValue('Unsaved name');
  expect(screen.getByRole('textbox', { name: catalogs[locale]['roles.prompt'] })).toHaveValue('Unsaved instructions');
  expect(screen.getByText('Draft App')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: catalogs[locale]['roles.save'] }));
  await waitFor(() => expect(rolesService.update).toHaveBeenCalledTimes(2));
  expect(rolesService.update).toHaveBeenLastCalledWith(role.id, { expectedCurrentVersionId: 'version-1', name: 'Unsaved name', prompt: 'Unsaved instructions', suggestedApps: [{ mcpServerName: 'Draft App' }] });
  expect(rolesService.get).toHaveBeenCalledTimes(1);
  expect(mockPush).not.toHaveBeenCalled();
});

it.each(locales)('localizes a real version-conflict response in %s without changing authored fields or publishing', async (locale) => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  jest.mocked(rolesService.get).mockResolvedValue(role);
  jest.mocked(rolesService.update).mockRejectedValue(new RolesApiError(409, 'This Role changed since it was read. Reload it and try again.'));
  render(<I18nProvider><RoleEditor mode="edit" roleId={role.id} /></I18nProvider>);
  const name = await screen.findByRole('textbox', { name: catalogs[locale]['roles.name'] });
  const prompt = screen.getByRole('textbox', { name: catalogs[locale]['roles.prompt'] });
  fireEvent.change(name, { target: { value: 'Preserved authored name' } });
  fireEvent.change(prompt, { target: { value: 'Preserved authored instructions' } });
  fireEvent.click(screen.getByRole('button', { name: catalogs[locale]['roles.save'] }));
  expect((await screen.findByText(catalogs[locale]['roles.changed'])).closest('[role="alert"]')).toBeInTheDocument();
  expect(name).toHaveValue('Preserved authored name');
  expect(prompt).toHaveValue('Preserved authored instructions');
  await waitFor(() => expect(screen.getByRole('button', { name: catalogs[locale]['roles.save'] })).toBeEnabled());
  expect(rolesService.update).toHaveBeenCalledWith(role.id, { expectedCurrentVersionId: role.currentVersionId, name: 'Preserved authored name', prompt: 'Preserved authored instructions', suggestedApps: [] });
  expect(mockPush).not.toHaveBeenCalled();
});
