import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import PackageInstallWizard from '@/frontend/components/Packages/PackageInstallWizard';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({
  __esModule: true,
  default: () => null,
}));

const installFromRegistry = jest.fn();
jest.mock('@/frontend/services/packages', () => ({
  packageService: { installFromRegistry: (...args: unknown[]) => installFromRegistry(...args) },
}));
jest.mock('@/frontend/contexts/I18nContext', () => {
  const t = (key: string) => ({
    'packages.install.action': 'Install package',
    'packages.install.close': 'Close',
    'packages.install.cancel': 'Cancel',
  }[key] ?? key);
  return {
    useI18n: () => ({
      formatNumber: (value: number) => String(value),
      formatList: (values: string[]) => values.join(', '),
      tp: (_key: string, count: number) => String(count),
      t,
    }),
  };
});

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

    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await waitFor(() => expect(installFromRegistry).toHaveBeenLastCalledWith(
      expect.objectContaining({ packageId: 'example', consentGranted: true }),
    ));
  });
});
