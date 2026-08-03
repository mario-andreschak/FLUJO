import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import McpAiConnectionPanel from '@/frontend/components/mcp/MCPServerManager/McpAiConnectionPanel';
import type { McpAssistantResearchResult } from '@/shared/types/mcp/assistant';

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
  beforeEach(() => {
    jest.clearAllMocks();
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
    const installButton = screen.getByRole('button', { name: /install and connect/i });
    expect(installButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/approve downloading and running this exact package command/i));
    expect(installButton).toBeEnabled();
    fireEvent.click(installButton);

    await waitFor(() => expect(installMcpRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({
      registryName: 'io.example/search',
      reviewedPlan,
      approved: true,
    })));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('search'));
  });
});
