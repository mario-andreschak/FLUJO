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

describe('RoleDetail', () => {
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
