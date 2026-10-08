import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConfigureTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab';
import type { MCPServerConfig } from '@/shared/types/mcp/mcp';

const handleSubmitMock = jest.fn();
const handleInstallMock = jest.fn();
const handleBuildMock = jest.fn();
const handleRunMock = jest.fn();

jest.mock('@/frontend/contexts/I18nContext', () => {
  const t = (key: string) => key;
  const formatNumber = (value: number) => String(value);
  return { useI18n: () => ({ t, formatNumber }) };
});

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/utils/formHandlers', () => ({
  handleSubmit: (...args: unknown[]) => handleSubmitMock(...args),
  handleParseClipboard: jest.fn(),
  handleParseEnvClipboard: jest.fn(),
  handleParseEnvExample: jest.fn(),
  handleParseReadme: jest.fn(),
  handleInstall: (...args: unknown[]) => handleInstallMock(...args),
  handleBuild: (...args: unknown[]) => handleBuildMock(...args),
  handleRun: (...args: unknown[]) => handleRunMock(...args),
  buildFinalConfig: (config: unknown) => config,
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/LocalServerForm', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/BuildTools', () => ({
  __esModule: true,
  default: ({ onInstall, onBuild }: { onInstall: () => Promise<void>; onBuild: () => Promise<void> }) => (
    <div>
      <button type="button" onClick={() => void onInstall()}>Install dependencies</button>
      <button type="button" onClick={() => void onBuild()}>Build server</button>
    </div>
  ),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/RunTools', () => ({
  __esModule: true,
  default: ({
    onRun,
    onSaveAndAuthenticate,
  }: {
    onRun: () => Promise<void>;
    onSaveAndAuthenticate?: () => Promise<void> | void;
  }) => (
    <div>
      <button type="button" onClick={() => void onRun()}>Test run</button>
      {onSaveAndAuthenticate ? (
        <button type="button" onClick={() => void onSaveAndAuthenticate()}>Save and authenticate</button>
      ) : null}
    </div>
  ),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/ArgumentsManager', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/RootsManager', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/SamplingManager', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/ElicitationManager', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/ConsoleOutput', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/shared/FolderPickerDialog', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/frontend/components/mcp/ToolParameterPresetsEditor', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/frontend/hooks/useServerTools', () => ({
  useServerTools: () => ({ tools: [], isLoading: false }),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/McpInstallTroubleshooter', () => ({
  __esModule: true,
  default: ({ context }: { context: { error: string } }) => (
    <div data-testid="install-troubleshooter" data-error={context.error}>AI installation helper</div>
  ),
}));

const initialConfig = {
  name: 'marketplace-server',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@example/server'],
  env: {},
  disabled: false,
  rootPath: 'C:/mcp/marketplace-server',
  _buildCommand: '',
  _installCommand: '',
};

const renderTab = (
  props: {
    autoTestRun?: boolean;
    handoffId?: number;
    onSaveAndAuthenticate?: (config: MCPServerConfig) => Promise<
      { status: 'authorized' } | { status: 'needs_client_credentials'; error?: string } | { status: 'error'; error?: string }
    >;
  } = {},
  config: MCPServerConfig = initialConfig,
) => render(
  <ConfigureTab
    initialConfig={config}
    onAdd={jest.fn()}
    onUpdate={jest.fn()}
    onClose={jest.fn()}
    {...props}
  />,
);

describe('ConfigureTab run and troubleshooting behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handleSubmitMock.mockImplementation((
      _event: unknown,
      _config: unknown,
      _websocketUrl: unknown,
      _serverUrl: unknown,
      _buildCommand: unknown,
      _installCommand: unknown,
      setMessage: (message: { type: 'error'; text: string }) => void,
    ) => setMessage({ type: 'error', text: 'Unrelated save validation error' }));
    handleInstallMock.mockImplementation(async (...args: unknown[]) => {
      const setBuildMessage = args[3] as (message: { type: 'success'; text: string }) => void;
      const setInstallCompleted = args[7] as (completed: boolean) => void;
      setBuildMessage({ type: 'success', text: 'Installed' });
      setInstallCompleted(true);
      return true;
    });
    handleBuildMock.mockImplementation(async (...args: unknown[]) => {
      const setBuildMessage = args[3] as (message: { type: 'success'; text: string }) => void;
      const setBuildCompleted = args[7] as (completed: boolean) => void;
      setBuildMessage({ type: 'success', text: 'Built' });
      setBuildCompleted(true);
      return true;
    });
    handleRunMock.mockImplementation(async (...args: unknown[]) => {
      const setMessage = args[7] as (message: { type: 'success'; text: string }) => void;
      const setRunCompleted = args[8] as (completed: boolean) => void;
      setMessage({ type: 'success', text: 'Connected' });
      setRunCompleted(true);
    });
  });

  it('collapses the green run section after a Marketplace auto-run succeeds', async () => {
    const { container } = renderTab({ autoTestRun: true, handoffId: 7 });

    await waitFor(() => expect(handleRunMock).toHaveBeenCalledTimes(1));
    const runHeader = container.querySelector('#run-header');
    await waitFor(() => expect(runHeader).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByTestId('install-troubleshooter')).not.toBeInTheDocument();
  });

  it('prepares a GitHub handoff and collapses every successful section', async () => {
    const githubConfig: MCPServerConfig = {
      ...initialConfig,
      name: 'github-server',
      source: { type: 'github', repositoryUrl: 'https://github.com/example/server' },
      _installCommand: 'npm install',
      _buildCommand: 'npm run build',
    };
    const { container } = renderTab(
      { autoTestRun: true, handoffId: 8 },
      githubConfig,
    );

    await waitFor(() => expect(handleInstallMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handleBuildMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handleRunMock).toHaveBeenCalledTimes(1));
    expect(handleInstallMock.mock.invocationCallOrder[0]).toBeLessThan(handleBuildMock.mock.invocationCallOrder[0]);
    expect(handleBuildMock.mock.invocationCallOrder[0]).toBeLessThan(handleRunMock.mock.invocationCallOrder[0]);

    for (const id of ['#define-server-header', '#build-header', '#run-header']) {
      await waitFor(() => expect(container.querySelector(id)).toHaveAttribute('aria-expanded', 'false'));
    }
  });

  it('reopens GitHub preparation when install fails and does not attempt later stages', async () => {
    handleInstallMock.mockImplementationOnce(async (...args: unknown[]) => {
      const setBuildMessage = args[3] as (message: { type: 'error'; text: string }) => void;
      setBuildMessage({ type: 'error', text: 'Install script failed' });
      return false;
    });
    const githubConfig: MCPServerConfig = {
      ...initialConfig,
      name: 'github-server',
      source: { type: 'github', repositoryUrl: 'https://github.com/example/server' },
      _installCommand: 'npm install',
      _buildCommand: 'npm run build',
    };
    const { container } = renderTab(
      { autoTestRun: true, handoffId: 9 },
      githubConfig,
    );

    await waitFor(() => expect(handleInstallMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('#build-header')).toHaveAttribute('aria-expanded', 'true'));
    expect(handleBuildMock).not.toHaveBeenCalled();
    expect(handleRunMock).not.toHaveBeenCalled();
  });

  it('shows the helper at the top for form and test-run errors', async () => {
    const { container } = renderTab();

    expect(screen.queryByTestId('install-troubleshooter')).not.toBeInTheDocument();
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByTestId('install-troubleshooter')).toHaveAttribute(
      'data-error',
      'Form/configuration: Unrelated save validation error',
    );

    handleRunMock.mockImplementationOnce(async (...args: unknown[]) => {
      const setMessage = args[7] as (message: { type: 'error'; text: string }) => void;
      setMessage({ type: 'error', text: 'Test connection failed' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test run' }));

    const helper = await screen.findByTestId('install-troubleshooter');
    expect(helper).toHaveAttribute(
      'data-error',
      'Form/configuration: Unrelated save validation error\nTest run: Test connection failed',
    );
    const runHeader = container.querySelector('#run-header')!;
    expect(helper.compareDocumentPosition(runHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('tracks install and build failures independently', async () => {
    renderTab();
    handleInstallMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const setBuildMessage = args[3] as (message: { type: 'error'; text: string }) => void;
        setBuildMessage({ type: 'error', text: 'Install script failed' });
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const setBuildMessage = args[3] as (message: { type: 'success'; text: string }) => void;
        setBuildMessage({ type: 'success', text: 'Installed' });
      });

    fireEvent.click(screen.getByRole('button', { name: 'Install dependencies' }));
    expect(await screen.findByTestId('install-troubleshooter')).toHaveAttribute('data-error', 'Install: Install script failed');

    fireEvent.click(screen.getByRole('button', { name: 'Install dependencies' }));
    await waitFor(() => expect(screen.queryByTestId('install-troubleshooter')).not.toBeInTheDocument());

    handleBuildMock.mockImplementationOnce(async (...args: unknown[]) => {
      const setBuildMessage = args[3] as (message: { type: 'error'; text: string }) => void;
      setBuildMessage({ type: 'error', text: 'Build command failed' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build server' }));
    expect(await screen.findByTestId('install-troubleshooter')).toHaveAttribute('data-error', 'Build: Build command failed');
  });

  it('shows the helper for authentication failures', async () => {
    const onSaveAndAuthenticate = jest.fn(async () => ({
      status: 'error' as const,
      error: 'OAuth exchange failed',
    }));
    const authConfig: MCPServerConfig = {
      ...initialConfig,
      transport: 'streamable',
      serverUrl: 'https://example.com/mcp',
      headers: {},
    };
    renderTab({ onSaveAndAuthenticate }, authConfig);

    fireEvent.click(screen.getByRole('button', { name: 'Save and authenticate' }));

    expect(await screen.findByTestId('install-troubleshooter')).toHaveAttribute(
      'data-error',
      'Authentication: OAuth exchange failed',
    );
  });
});
