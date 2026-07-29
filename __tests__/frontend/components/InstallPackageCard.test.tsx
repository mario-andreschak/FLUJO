import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const searchRegistryMock = jest.fn();
const installFromRegistryMock = jest.fn();
const getRegistryStatusMock = jest.fn();
const deletePackageMock = jest.fn();

jest.mock('@/frontend/services/packages', () => ({
  packageService: {
    searchRegistry: (...args: unknown[]) => searchRegistryMock(...args),
    installFromRegistry: (...args: unknown[]) => installFromRegistryMock(...args),
  },
}));

jest.mock('@/frontend/services/registry', () => ({
  registryService: {
    getStatus: (...args: unknown[]) => getRegistryStatusMock(...args),
    deletePackage: (...args: unknown[]) => deletePackageMock(...args),
  },
}));

import InstallPackageCard from '@/frontend/components/Packages/InstallPackageCard';

describe('InstallPackageCard', () => {
  beforeEach(() => {
    searchRegistryMock.mockReset();
    installFromRegistryMock.mockReset();
    getRegistryStatusMock.mockReset();
    deletePackageMock.mockReset();

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
    getRegistryStatusMock.mockResolvedValue({
      signedIn: true,
      publisherHandle: 'publisher',
      isConfirmed: true,
      hasToken: true,
      token: '********',
      email: 'publisher@example.com',
    });
    deletePackageMock.mockResolvedValue({ ok: true });
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

  it('lets the signed-in publisher permanently delete their package after confirmation', async () => {
    render(<InstallPackageCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Example package' }));
    expect(screen.getByText('Delete package?')).toBeInTheDocument();
    expect(screen.getByText(/all of its published versions/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete package' }));

    await waitFor(() => expect(deletePackageMock).toHaveBeenCalledWith('example-package'));
  });

  it('does not show delete controls on another publisher’s package', async () => {
    getRegistryStatusMock.mockResolvedValue({
      signedIn: true,
      publisherHandle: 'someone-else',
      isConfirmed: true,
      hasToken: true,
      token: '********',
      email: 'other@example.com',
    });

    render(<InstallPackageCard />);

    await screen.findByText('Example package');
    await waitFor(() => expect(getRegistryStatusMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Delete Example package' })).not.toBeInTheDocument();
  });
});
