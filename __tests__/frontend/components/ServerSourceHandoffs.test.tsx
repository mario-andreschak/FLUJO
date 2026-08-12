import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import GitHubTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/GitHubTab';
import RemoteTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/RemoteTab';

const validateGitHubUrlMock = jest.fn();
const cloneRepositoryMock = jest.fn();
const detectRepositoryConfigMock = jest.fn();
const probeOAuthCapabilityMock = jest.fn();

jest.mock('@/frontend/contexts/I18nContext', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});

jest.mock('@/frontend/utils/theme', () => ({
  useThemeUtils: () => ({ getThemeColor: () => '#000' }),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/gitHubUtils', () => ({
  validateGitHubUrl: (...args: unknown[]) => validateGitHubUrlMock(...args),
  cloneRepository: (...args: unknown[]) => cloneRepositoryMock(...args),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configDetection', () => ({
  detectRepositoryConfig: (...args: unknown[]) => detectRepositoryConfigMock(...args),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configUtils', () => ({
  parseEnvVariables: () => ({}),
}));

jest.mock('@/utils/mcp', () => ({
  parseServerConfig: jest.fn(() => ({ config: {} })),
}));

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    probeOAuthCapability: (...args: unknown[]) => probeOAuthCapabilityMock(...args),
  },
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/SamplingManager', () => ({
  __esModule: true,
  default: () => null,
}));

const originalFetch = global.fetch;

describe('streamlined server-source handoffs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async () => ({
      json: async () => ({ success: true, mcpServersDir: 'C:/workspace/mcp-servers', exists: false }),
    })) as jest.Mock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('hands a validated remote URL to Configure with auto-test enabled', async () => {
    probeOAuthCapabilityMock.mockResolvedValue({ oauthCapable: false });
    const onHandoff = jest.fn();
    render(
      <RemoteTab
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onHandoff={onHandoff}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://mcp.example.com/api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'mcp.remote.connect' }));

    await waitFor(() => expect(onHandoff).toHaveBeenCalledWith({
      to: 'configure',
      autoTestRun: true,
      config: expect.objectContaining({
        name: 'mcp-example-com',
        rootPath: 'mcp-servers/mcp-example-com',
        serverUrl: 'https://mcp.example.com/api',
        source: { type: 'remote' },
      }),
    }));
  });

  it('hands a runnable GitHub clone to Configure with auto-test enabled', async () => {
    validateGitHubUrlMock.mockResolvedValue({
      repoInfo: { owner: 'example', repo: 'weather-mcp', valid: true },
      message: { type: 'success', text: 'valid' },
      showCloneButton: true,
    });
    cloneRepositoryMock.mockResolvedValue({
      success: true,
      clonedRepoPath: 'C:/workspace/mcp-servers/weather-mcp',
      message: { type: 'success', text: 'cloned' },
    });
    detectRepositoryConfigMock.mockResolvedValue({
      success: true,
      message: { type: 'success', text: 'detected' },
      config: {
        name: 'weather-mcp',
        transport: 'stdio',
        command: 'node',
        args: ['dist/index.js'],
        env: {},
        disabled: false,
        _installCommand: 'npm install',
        _buildCommand: 'npm run build',
      },
    });
    const onHandoff = jest.fn();
    render(
      <GitHubTab
        initialGitHubUrl="https://github.com/example/weather-mcp"
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onHandoff={onHandoff}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'mcp.github.parse' }));
    await screen.findByRole('button', { name: 'mcp.github.clone' });
    fireEvent.click(screen.getByRole('button', { name: 'mcp.github.clone' }));

    await waitFor(() => expect(onHandoff).toHaveBeenCalledWith({
      to: 'configure',
      autoTestRun: true,
      config: expect.objectContaining({
        name: 'weather-mcp',
        rootPath: 'C:/workspace/mcp-servers/weather-mcp',
        source: {
          type: 'github',
          repositoryUrl: 'https://github.com/example/weather-mcp',
        },
      }),
    }));
  });
});
