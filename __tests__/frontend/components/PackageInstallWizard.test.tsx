import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PackageInstallWizard from '@/frontend/components/Packages/PackageInstallWizard';

const installFromRegistry = jest.fn();
jest.mock('@/frontend/services/packages', () => ({
  packageService: { installFromRegistry: (...args: unknown[]) => installFromRegistry(...args) },
}));
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    formatNumber: (value: number) => String(value),
    t: (key: string) => ({
      'packages.install.action': 'Install package',
      'packages.install.close': 'Close',
      'packages.install.cancel': 'Cancel',
    }[key] ?? key),
  }),
}));

describe('PackageInstallWizard', () => {
  beforeEach(() => {
    installFromRegistry.mockReset()
      .mockResolvedValueOnce({
        ok: true, dryRun: true, package: { name: 'Example', version: '1.0.0' },
        preview: { servers: [], models: [], installedModels: [], flows: [], plannedExecutions: [], secrets: [], globals: [], missingGlobals: [] },
        created: [], updated: [], skipped: [], disabled: [], errors: [], servers: [], missingGlobals: [],
      })
      .mockResolvedValueOnce({
        ok: true, dryRun: false, package: { name: 'Example', version: '1.0.0' },
        created: [], updated: [], skipped: [], disabled: [], errors: [], servers: [], missingGlobals: [],
      });
  });

  it('omits unnecessary steps and only writes on the final accessible action', async () => {
    render(<PackageInstallWizard open packageId="example" packageName="Example" onClose={jest.fn()} />);
    const install = await screen.findByRole('button', { name: 'Install package' });
    expect(installFromRegistry).toHaveBeenCalledWith(expect.objectContaining({ packageId: 'example', consentGranted: false }));

    fireEvent.click(install);
    await waitFor(() => expect(installFromRegistry).toHaveBeenLastCalledWith(
      expect.objectContaining({ packageId: 'example', consentGranted: true }),
    ));
  });
});
