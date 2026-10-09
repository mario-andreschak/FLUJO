import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import McpAiConnectionPanel from '@/frontend/components/mcp/MCPServerManager/McpAiConnectionPanel';
import type { McpAssistantResearchResult } from '@/shared/types/mcp/assistant';
import { modelService } from '@/frontend/services/model';

const researchMcpConnectionMock = jest.fn();
const installMcpRecommendationMock = jest.fn();

jest.mock('@/frontend/services/model', () => ({
  modelService: {
    loadModels: jest.fn(async () => [{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }]),
  },
}));

jest.mock('@/frontend/services/mcp/assistant', () => ({
  researchMcpConnection: (...args: unknown[]) => researchMcpConnectionMock(...args),
  installMcpRecommendation: (...args: unknown[]) => installMcpRecommendationMock(...args),
}));

const reviewedPlan = {
  registryName: 'io.example/search',
  resolvedName: 'io.example/search',
  serverName: 'search',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@example/search'],
  requiredEnvNames: [],
  verificationStatus: 'active',
};

const result: McpAssistantResearchResult = {
  query: 'free web search',
  summary: 'This is the strongest reviewed option.',
  recommendedId: 'io.example/search::stdio',
  generatedAt: new Date(0).toISOString(),
  sources: [{ id: 'registry', label: 'Official MCP Registry', url: 'https://registry.modelcontextprotocol.io', status: 'searched' }],
  candidates: [{
    id: 'io.example/search::stdio',
    registryName: 'io.example/search',
    title: 'Example Search',
    description: 'Searches the public web.',
    score: 0.92,
    recommended: true,
    plan: reviewedPlan,
    config: { name: 'search', transport: 'stdio', command: 'npx', args: ['-y', '@example/search'] },
    authMode: 'none',
    freeNote: 'Free to install locally.',
    reasons: ['Popular npm package'],
    warnings: [],
    requiredInputs: [],
    weeklyDownloads: 25000,
    verificationStatus: 'active',
    alternateTransports: ['stdio'],
  }],
};

describe('McpAiConnectionPanel', () => {
  it('claims research synchronously when click and Enter arrive in the same update', async () => {
    let finish!: (value: McpAssistantResearchResult) => void;
    researchMcpConnectionMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    const request = screen.getByLabelText(/one thing to connect/i);
    fireEvent.change(request, { target: { value: 'search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /research options/i }));
      fireEvent.keyDown(request, { key: 'Enter' });
    });
    expect(researchMcpConnectionMock).toHaveBeenCalledTimes(1);
    await act(async () => { finish(result); });
    expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled();
  });
  it('does not authenticate or refresh after an installing panel unmounts', async () => {
    let finish!: (value: unknown) => void;
    researchMcpConnectionMock.mockResolvedValue(result);
    installMcpRecommendationMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onInstalled = jest.fn();
    const onAuthenticate = jest.fn(async () => undefined);
    const view = render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={onInstalled} onAuthenticate={onAuthenticate} onManual={jest.fn()} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /research options/i }));
    fireEvent.click(await screen.findByLabelText(/approve downloading and running this exact package command/i));
    fireEvent.click(screen.getByRole('button', { name: /install and connect/i }));
    view.unmount();
    await act(async () => { finish({ installed: true, serverName: 'search', needsAuthentication: true }); });
    expect(onAuthenticate).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(modelService.loadModels).mockReset().mockResolvedValue([{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }] as never);
  });

  it('retries a failed model load without losing the request or remounting', async () => {
    jest.mocked(modelService.loadModels).mockRejectedValueOnce(new Error('Temporary connection failure'));
    researchMcpConnectionMock.mockResolvedValue(result);
    const onManual = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={onManual} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'free web search' } });
    await screen.findByRole('button', { name: /retry loading models/i });
    expect(screen.getByRole('button', { name: /research options/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /open manual setup/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /retry loading models/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    expect(screen.getByLabelText(/one thing to connect/i)).toHaveValue('free web search');
    expect(modelService.loadModels).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load AI models.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /research options/i }));
    await waitFor(() => expect(researchMcpConnectionMock).toHaveBeenCalledWith(
      { query: 'free web search', modelId: 'model-1' }, expect.any(Function), expect.any(AbortSignal),
    ));
  });

  it('offers manual setup when no models are configured', async () => {
    jest.mocked(modelService.loadModels).mockResolvedValueOnce([]);
    const onManual = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={onManual} />
    </ThemeProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /open manual setup/i }));
    expect(onManual).toHaveBeenCalledTimes(1);
    expect(researchMcpConnectionMock).not.toHaveBeenCalled();
  });

  it('streams research progress, shows the exact plan, and installs only after approval', async () => {
    let finishResearch!: (value: McpAssistantResearchResult) => void;
    researchMcpConnectionMock.mockImplementation(async (_input, onEvent) => {
      await onEvent({ type: 'progress', stage: 'web', message: 'Checking GitHub and npm…' });
      return new Promise<McpAssistantResearchResult>((resolve) => { finishResearch = resolve; });
    });
    installMcpRecommendationMock.mockResolvedValue({ installed: true, serverName: 'search', tools: [{ name: 'search' }] });
    const onInstalled = jest.fn(async () => undefined);

    render(
      <ThemeProvider theme={createTheme()}>
        <McpAiConnectionPanel onInstalled={onInstalled} onAuthenticate={jest.fn()} onManual={jest.fn()} />
      </ThemeProvider>,
    );

    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'free web search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /research options/i }));
    expect(await screen.findByText('Checking GitHub and npm…')).toBeInTheDocument();

    await act(async () => { finishResearch(result); });
    expect(await screen.findByText('npx -y @example/search')).toBeInTheDocument();
    expect(screen.getByLabelText(/connection name/i)).toHaveValue('search');
    const installButton = screen.getByRole('button', { name: /install and connect/i });
    expect(installButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/approve downloading and running this exact package command/i));
    expect(installButton).toBeEnabled();
    fireEvent.click(installButton);

    await waitFor(() => expect(installMcpRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({
      registryName: 'io.example/search',
      serverName: 'search',
      reviewedPlan: { ...reviewedPlan, serverName: 'search' },
      approved: true,
    })));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('search'));
  });

  it('does not render an Authorization credential field for an OAuth DCR recommendation', async () => {
    const dcrPlan = {
      ...reviewedPlan,
      registryName: 'com.paypal.mcp/mcp',
      resolvedName: 'com.paypal.mcp/mcp',
      serverName: 'paypal',
      transport: 'streamable' as const,
      command: undefined,
      args: undefined,
      serverUrl: 'https://mcp.paypal.com/mcp',
      requiredEnvNames: [],
    };
    const dcrResult: McpAssistantResearchResult = {
      ...result,
      query: 'PayPal',
      recommendedId: 'com.paypal.mcp/mcp::streamable',
      candidates: [{
        ...result.candidates[0],
        id: 'com.paypal.mcp/mcp::streamable',
        registryName: 'com.paypal.mcp/mcp',
        title: 'PayPal',
        plan: dcrPlan,
        config: { name: 'paypal', transport: 'streamable', serverUrl: dcrPlan.serverUrl, headers: {} },
        authMode: 'oauth-dcr',
        requiredInputs: [],
        alternateTransports: ['streamable'],
      }],
    };
    researchMcpConnectionMock.mockResolvedValue(dcrResult);
    installMcpRecommendationMock.mockResolvedValue({
      installed: true,
      serverName: 'paypal',
      needsAuthentication: true,
    });

    render(
      <ThemeProvider theme={createTheme()}>
        <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
      </ThemeProvider>,
    );

    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'PayPal' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /research options/i }));

    expect(await screen.findByLabelText(/connection name/i)).toHaveValue('paypal');
    expect(screen.queryByLabelText(/^Authorization$/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/approve saving and connecting/i));
    const installButton = screen.getByRole('button', { name: /install and connect/i });
    expect(installButton).toBeEnabled();
    fireEvent.click(installButton);

    await waitFor(() => expect(installMcpRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'paypal',
      inputs: {},
      authMode: 'oauth-dcr',
    })));
  });
});
