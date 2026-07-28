import { fireEvent, render, screen } from '@testing-library/react';

const searchRegistryMock = jest.fn();
const installFromRegistryMock = jest.fn();

jest.mock('@/frontend/services/packages', () => ({
  packageService: {
    searchRegistry: (...args: unknown[]) => searchRegistryMock(...args),
    installFromRegistry: (...args: unknown[]) => installFromRegistryMock(...args),
  },
}));

import InstallPackageCard from '@/frontend/components/Packages/InstallPackageCard';

describe('InstallPackageCard', () => {
  beforeEach(() => {
    searchRegistryMock.mockReset();
    installFromRegistryMock.mockReset();

    searchRegistryMock.mockResolvedValue({
      items: [
        {
          id: 'example-package',
          name: 'Example package',
          handle: '@publisher/example-package',
          latestVersion: '1.0.0',
          description: 'A package with a secret',
          tags: [],
          downloads: 0,
        },
      ],
    });

    installFromRegistryMock.mockResolvedValue({
      ok: true,
      dryRun: true,
      package: { name: 'Example package', version: '1.0.0' },
      preview: {
        servers: [],
        models: [],
        flows: [],
        plannedExecutions: [],
        secrets: [
          {
            key: 'API_KEY',
            label: 'API key',
            required: true,
            provided: false,
          },
        ],
        missingGlobals: [],
      },
      created: [],
      updated: [],
      skipped: [],
      disabled: [],
      servers: [],
      errors: [],
      missingGlobals: [],
    });
  });

  it('shows and hides a package secret when its visibility button is toggled', async () => {
    render(<InstallPackageCard />);

    fireEvent.click(await screen.findByText('Example package'));

    const secretInput = await screen.findByLabelText('API key');
    expect(secretInput).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show secret' }));
    expect(secretInput).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide secret' }));
    expect(secretInput).toHaveAttribute('type', 'password');
  });
});
