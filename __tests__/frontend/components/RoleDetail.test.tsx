/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';

const getMock = jest.fn();
const impactMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/frontend/services/roles', () => ({
  rolesService: {
    get: (...args: unknown[]) => getMock(...args),
    impact: (...args: unknown[]) => impactMock(...args),
  },
}));

jest.mock('@/frontend/components/Roles/RoleActionMenu', () => () => null);
jest.mock('@/frontend/components/Roles/RoleVersionHistory', () => () => null);

import RoleDetail from '@/frontend/components/Roles/RoleDetail';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY } from '@/frontend/i18n/locales';
import { buildDefaultRoleBehaviorSlots } from '@/backend/services/enduringAgents/roleBehaviorDefaults';

describe('RoleDetail', () => {
  afterEach(() => localStorage.removeItem(LOCALE_STORAGE_KEY));

  it('shows German default Behavior labels alongside unchanged owner content', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'de');
    getMock.mockResolvedValue({
      id: 'role_test', name: 'My English role', prompt: 'Keep my instructions.',
      suggestedApps: [], archived: false, currentVersionId: 'v1', createdAt: 1, updatedAt: 1,
      behaviors: [
        ...buildDefaultRoleBehaviorSlots('role_test', 'My English role'),
        { key: 'custom', name: 'My custom behavior', description: 'Keep this exact description.' },
      ],
    });
    impactMock.mockResolvedValue({ personaCount: 0, personaIds: [], pinnedRoleVersionIds: [], hardDeleteAllowed: true });
    render(<I18nProvider><RoleDetail roleId="role_test" /></I18nProvider>);
    expect(await screen.findByText('Hauptaufgabe')).toBeInTheDocument();
    expect(screen.getByText('Erinnerungen pflegen')).toBeInTheDocument();
    expect(screen.getByText('Erledigt die dieser Rolle zugewiesenen Aufgaben.')).toBeInTheDocument();
    expect(screen.getByText('Schlägt nach erledigten Aufgaben hilfreiche Erinnerungen vor.')).toBeInTheDocument();
    expect(screen.getByText('My custom behavior')).toBeInTheDocument();
    expect(screen.getByText('Keep this exact description.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My English role' })).toBeInTheDocument();
    expect(screen.queryByText('Maintain memory')).not.toBeInTheDocument();
  });

  it('shows the required behaviors materialized for Personas', async () => {
    getMock.mockResolvedValue({
      id: 'role_product_owner',
      name: 'Product Owner',
      prompt: 'Own the product vision.',
      suggestedApps: [],
      behaviors: [
        {
          key: 'primary',
          name: 'Primary',
          description: 'Perform the Role’s assigned work using its immutable instructions.',
        },
        {
          key: 'maintain_memory',
          name: 'Maintain memory',
          description: 'Propose trustworthy memories after an Activity.',
        },
      ],
      archived: false,
      currentVersionId: 'rolever_product_owner_v1',
      createdAt: 1,
      updatedAt: 1,
    });
    impactMock.mockResolvedValue({
      roleId: 'role_product_owner',
      personaIds: ['jim'],
      personaCount: 1,
      pinnedRoleVersionIds: ['rolever_product_owner_v1'],
      hardDeleteAllowed: false,
      safeAction: 'archive',
    });

    render(<RoleDetail roleId="role_product_owner" />);

    expect(await screen.findByRole('heading', { name: 'Required behaviors' }))
      .toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('Maintain memory')).toBeInTheDocument();
    expect(screen.getByText('Propose trustworthy memories after an Activity.'))
      .toBeInTheDocument();
  });
});
