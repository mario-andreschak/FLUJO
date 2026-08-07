import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({
  __esModule: true,
  default: () => null,
}));

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
        globals: [],
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


  it('shows repository-provided commands before installing a GitHub server', async () => {
    installFromRegistryMock.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      package: { name: 'Example package', version: '1.0.0' },
      preview: {
        servers: [
          {
            localName: 'github-server',
            source: 'https://github.com/example/server',
            requiredEnvMissing: [],
            installCommand: 'pnpm install --frozen-lockfile',
            buildCommand: 'pnpm run build',
          },
        ],
        models: [],
        installedModels: [],
        flows: [],
        plannedExecutions: [],
        secrets: [],
        globals: [],
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

    render(<InstallPackageCard />);
    fireEvent.click(await screen.findByText('Example package'));

    expect(await screen.findByRole('heading', { name: 'Review and install' })).toBeInTheDocument();
    expect(
      screen.getByText(/repository-provided commands on your machine/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Install command')).toBeInTheDocument();
    expect(screen.getByText('pnpm install --frozen-lockfile')).toBeInTheDocument();
    expect(screen.getByText('Build command')).toBeInTheDocument();
    expect(screen.getByText('pnpm run build')).toBeInTheDocument();
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

  it('guides the user through substituting a package model with an installed model', async () => {
    installFromRegistryMock
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        package: { name: 'Example package', version: '1.0.0' },
        preview: {
          servers: [],
          models: [{ id: 'package-model', displayName: 'Package Claude' }],
          installedModels: [
            { id: 'installed-model', displayName: 'My Claude', name: 'claude-sonnet' },
          ],
          flows: [{ name: 'Example flow' }],
          plannedExecutions: [],
          secrets: [],
          globals: [],
          missingGlobals: [],
        },
        created: [],
        updated: [],
        skipped: [],
        disabled: [],
        servers: [],
        errors: [],
        missingGlobals: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        dryRun: false,
        package: { name: 'Example package', version: '1.0.0' },
        created: [],
        updated: [],
        skipped: [],
        disabled: [],
        servers: [],
        errors: [],
        missingGlobals: [],
      });

    render(<InstallPackageCard />);
    fireEvent.click(await screen.findByText('Example package'));

    expect(await screen.findByText(/created with models that are not installed/i)).toBeInTheDocument();
    const continueButton = screen.getByRole('button', { name: /Continue to review/i });
    expect(continueButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Use one of yours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use My Claude' }));
    expect(continueButton).toBeEnabled();

    fireEvent.click(continueButton);
    expect(screen.getByRole('heading', { name: 'Review and install' })).toBeInTheDocument();
    expect(screen.getByText('My Claude')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Install package' }));

    await waitFor(() => {
      expect(installFromRegistryMock).toHaveBeenLastCalledWith(expect.objectContaining({
        packageId: 'example-package',
        modelMappings: { 'package-model': 'installed-model' },
        consentGranted: true,
      }));
    });
  });

  it('saves declared globals with their secret metadata before install', async () => {
    installFromRegistryMock
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        package: { name: 'Example package', version: '1.0.0' },
        preview: {
          servers: [],
          models: [],
          installedModels: [],
          flows: [],
          plannedExecutions: [],
          secrets: [],
          globals: [
            { name: 'REPOSITORY_URL', description: 'Repository URL', required: true, isSecret: false },
            { name: 'API_TOKEN', description: 'API token', required: true, isSecret: true },
          ],
          missingGlobals: ['REPOSITORY_URL', 'API_TOKEN'],
        },
        created: [],
        updated: [],
        skipped: [],
        disabled: [],
        servers: [],
        errors: [],
        missingGlobals: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        dryRun: false,
        package: { name: 'Example package', version: '1.0.0' },
        created: [],
        updated: [],
        skipped: [],
        disabled: [],
        servers: [],
        errors: [],
        missingGlobals: [],
      });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<InstallPackageCard />);
    fireEvent.click(await screen.findByText('Example package'));
    fireEvent.change(await screen.findByLabelText('REPOSITORY_URL'), {
      target: { value: 'https://github.com/example/repo' },
    });
    fireEvent.change(screen.getByLabelText('API_TOKEN'), {
      target: { value: 'secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install package' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/env', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'setAll',
          variables: {
            REPOSITORY_URL: {
              value: 'https://github.com/example/repo',
              metadata: { isSecret: false },
            },
            API_TOKEN: {
              value: 'secret-token',
              metadata: { isSecret: true },
            },
          },
        }),
      })),
    );
    await waitFor(() => expect(installFromRegistryMock).toHaveBeenCalledTimes(2));
    delete (global as { fetch?: unknown }).fetch;
  });
});
