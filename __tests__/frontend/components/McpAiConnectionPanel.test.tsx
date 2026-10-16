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
    tryLoadModels: jest.fn(async () => [{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }]),
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

async function beginApprovedInstall(props: Partial<React.ComponentProps<typeof McpAiConnectionPanel>>) {
  researchMcpConnectionMock.mockResolvedValue(result);
  const view = render(<ThemeProvider theme={createTheme()}>
    <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} {...props} />
  </ThemeProvider>);
  fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'web search' } });
  await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /find options/i }));
  fireEvent.click(await screen.findByLabelText(/approve downloading and running this exact package command/i));
  fireEvent.click(screen.getByRole('button', { name: /install and connect/i }));
  return view;
}

describe('McpAiConnectionPanel', () => {
  it('shows the recommendation category and evidenced service cost before consent', async () => {
    researchMcpConnectionMock.mockResolvedValue({
      ...result,
      candidates: [{ ...result.candidates[0], recommendationTier: 'flujo-supported',
        cost: { kind: 'byok', evidence: 'The service requires your own provider account; usage charges may apply.' } }],
    });
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'free web search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    expect(await screen.findByText('Supported by FLUJO')).toBeInTheDocument();
    expect(screen.getByText('Bring your own key')).toBeInTheDocument();
    expect(screen.getByText('The service requires your own provider account; usage charges may apply.')).toBeInTheDocument();
    expect(installMcpRecommendationMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /install and connect/i })).toBeDisabled();
  });

  it('opens an existing bundled server configuration without install consent or provider effects', async () => {
    researchMcpConnectionMock.mockResolvedValue({ ...result, candidates: [{ ...result.candidates[0],
      action: 'configure-existing', existingServerName: 'filesystem', recommendationTier: 'flujo-supported',
      cost: { kind: 'free', evidence: 'Local filesystem tools; no service account is required.' } }] });
    const configure = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} onConfigureExisting={configure} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'work with local files' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    fireEvent.click(await screen.findByRole('button', { name: /configure existing server/i }));
    expect(configure).toHaveBeenCalledWith('filesystem');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install and connect/i })).not.toBeInTheDocument();
    expect(installMcpRecommendationMock).not.toHaveBeenCalled();
  });

  it('keeps unknown service pricing explicit and does not label a keyless connector free', async () => {
    researchMcpConnectionMock.mockResolvedValue({ ...result, candidates: [{ ...result.candidates[0],
      cost: { kind: 'unknown', evidence: 'The publisher supplied no service pricing evidence.' } }] });
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'web search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    expect(await screen.findByText('Service pricing unconfirmed')).toBeInTheDocument();
    expect(screen.queryByText('Free for this capability')).not.toBeInTheDocument();
  });

  it('offers manual setup when only agent, media or fallback models exist', async () => {
    jest.mocked(modelService.tryLoadModels).mockResolvedValueOnce([
      { id: 'cli', name: 'CLI agent', adapter: 'codex-cli' },
      { id: 'media', name: 'Image route', adapter: 'openai', outputModalities: ['text', 'image'] },
      { id: 'fallback', name: 'Routing policy', adapter: 'openai', fallbackPolicy: { enabled: true } },
    ] as never);
    const manual = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={manual} />
    </ThemeProvider>);
    expect(await screen.findByText(/no saved AI is available for this search/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /find included options/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /set up myself/i }));
    expect(manual).toHaveBeenCalledTimes(1); expect(researchMcpConnectionMock).not.toHaveBeenCalled();
  });

  it('can find and configure bundled options without a model account', async () => {
    jest.mocked(modelService.tryLoadModels).mockResolvedValueOnce([]);
    researchMcpConnectionMock.mockResolvedValue({ ...result, candidates: [{ ...result.candidates[0],
      action: 'configure-existing', existingServerName: 'filesystem', recommendationTier: 'flujo-supported', cost: { kind: 'free' } }] });
    const configure = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} onConfigureExisting={configure} />
    </ThemeProvider>);
    await screen.findByText(/no saved AI is available for this search/i);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'work with local files' } });
    fireEvent.click(screen.getByRole('button', { name: /find included options/i }));
    fireEvent.click(await screen.findByRole('button', { name: /configure existing server/i }));
    expect(researchMcpConnectionMock).toHaveBeenCalledWith({ query: 'work with local files', modelId: '' }, expect.any(Function), expect.any(AbortSignal));
    expect(configure).toHaveBeenCalledWith('filesystem'); expect(installMcpRecommendationMock).not.toHaveBeenCalled();
  });

  it('offers configuration when an approved install encounters an existing mismatched server', async () => {
    researchMcpConnectionMock.mockResolvedValue(result);
    installMcpRecommendationMock.mockResolvedValue({ installed: false, needsConfiguration: true, existingServerName: 'search', error: 'Configure existing server.' });
    const configure = jest.fn(), installed = jest.fn(), authenticate = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={installed} onAuthenticate={authenticate} onManual={jest.fn()} onConfigureExisting={configure} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'web search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    fireEvent.click(await screen.findByLabelText(/approve downloading and running this exact package command/i));
    fireEvent.click(screen.getByRole('button', { name: /install and connect/i }));
    fireEvent.click(await screen.findByRole('button', { name: /configure existing server/i }));
    expect(configure).toHaveBeenCalledWith('search');
    expect(installed).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('clears an existing-server conflict when the connection name changes', async () => {
    researchMcpConnectionMock.mockResolvedValue(result);
    installMcpRecommendationMock.mockResolvedValue({ installed: false, needsConfiguration: true, existingServerName: 'search' });
    const configure = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} onConfigureExisting={configure} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'web search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    fireEvent.click(await screen.findByLabelText(/approve downloading and running this exact package command/i));
    fireEvent.click(screen.getByRole('button', { name: /install and connect/i }));
    await screen.findByRole('button', { name: /configure existing server/i });
    fireEvent.change(screen.getByLabelText(/connection name/i), { target: { value: 'other-search' } });
    expect(screen.queryByRole('button', { name: /configure existing server/i })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(configure).not.toHaveBeenCalled();
  });

  it('blocks manual navigation and model reload while a model-free handoff is pending', async () => {
    jest.mocked(modelService.tryLoadModels).mockResolvedValueOnce([]);
    researchMcpConnectionMock.mockResolvedValue({ ...result, candidates: [{ ...result.candidates[0],
      action: 'configure-existing', existingServerName: 'filesystem' }] });
    let finish!: () => void;
    const configure = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const manual = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={manual} onConfigureExisting={configure} />
    </ThemeProvider>);
    await screen.findByText(/no saved AI is available for this search/i);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'local files' } });
    fireEvent.click(screen.getByRole('button', { name: /find included options/i }));
    const handoff = await screen.findByRole('button', { name: /configure existing server/i });
    act(() => {
      fireEvent.click(handoff);
      fireEvent.click(screen.getByRole('button', { name: /set up myself/i }));
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    expect(screen.getByRole('button', { name: /set up myself/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled();
    expect(manual).not.toHaveBeenCalled();
    expect(modelService.tryLoadModels).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    fireEvent.click(screen.getByRole('button', { name: /set up myself/i }));
    expect(manual).toHaveBeenCalledTimes(1);
  });

  it('claims research synchronously when click and Enter arrive in the same update', async () => {
    let finish!: (value: McpAssistantResearchResult) => void;
    researchMcpConnectionMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    const request = screen.getByLabelText(/one thing to connect/i);
    fireEvent.change(request, { target: { value: 'search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /find options/i }));
      fireEvent.keyDown(request, { key: 'Enter' });
    });
    expect(researchMcpConnectionMock).toHaveBeenCalledTimes(1);
    await act(async () => { finish(result); });
    expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled();
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
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    fireEvent.click(await screen.findByLabelText(/approve downloading and running this exact package command/i));
    fireEvent.click(screen.getByRole('button', { name: /install and connect/i }));
    view.unmount();
    await act(async () => { finish({ installed: true, serverName: 'search', needsAuthentication: true }); });
    expect(onAuthenticate).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it.each([false, true])('waits for sign-in and handoff before showing connection success (existing: %s)', async alreadyExisted => {
    installMcpRecommendationMock.mockResolvedValue({ installed: true, serverName: 'search', needsAuthentication: true, alreadyExisted });
    let authenticate!: () => void;
    let installed!: () => void;
    const onAuthenticate = jest.fn(() => new Promise<void>(resolve => { authenticate = resolve; }));
    const onInstalled = jest.fn(() => new Promise<void>(resolve => { installed = resolve; }));
    await beginApprovedInstall({ onAuthenticate, onInstalled });
    await waitFor(() => expect(onAuthenticate).toHaveBeenCalledWith('search'));
    expect(screen.queryByText(/^search (?:is connected\.|was already connected\.)/i)).not.toBeInTheDocument();
    expect(onInstalled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();

    await act(async () => { authenticate(); });
    expect(onInstalled).toHaveBeenCalledWith('search');
    expect(screen.queryByText(/^search (?:is connected\.|was already connected\.)/i)).not.toBeInTheDocument();
    await act(async () => { installed(); });
    expect(await screen.findByText(alreadyExisted ? 'search was already connected. Your settings were kept.' : 'search is connected.')).toBeInTheDocument();
    expect(onAuthenticate).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(installMcpRecommendationMock).toHaveBeenCalledTimes(1);
  });

  it.each(['sign-in', 'handoff'])('shows the %s failure without a connection success receipt or automatic retry', async boundary => {
    installMcpRecommendationMock.mockResolvedValue({ installed: true, serverName: 'search', needsAuthentication: true });
    const message = boundary === 'sign-in' ? 'Sign-in failed. Open the app and sign in again.' : 'Could not finish connecting. Try again.';
    const onAuthenticate = boundary === 'sign-in'
      ? jest.fn(async () => { throw new Error(message); })
      : jest.fn(async () => undefined);
    const onInstalled = boundary === 'handoff'
      ? jest.fn(async () => { throw new Error(message); })
      : jest.fn(async () => undefined);
    await beginApprovedInstall({ onAuthenticate, onInstalled });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/^search (?:is connected\.|was already connected\.)/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/connection name/i)).toHaveValue('search');
    expect(screen.getByLabelText(/one thing to connect/i)).toHaveValue('web search');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: /install and connect/i })).toBeEnabled();
    expect(onAuthenticate).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledTimes(boundary === 'sign-in' ? 0 : 1);
    expect(installMcpRecommendationMock).toHaveBeenCalledTimes(1);
  });

  it('does not finish a connection when the panel unmounts during sign-in', async () => {
    installMcpRecommendationMock.mockResolvedValue({ installed: true, serverName: 'search', needsAuthentication: true });
    let authenticate!: () => void;
    const onAuthenticate = jest.fn(() => new Promise<void>(resolve => { authenticate = resolve; }));
    const onInstalled = jest.fn();
    const view = await beginApprovedInstall({ onAuthenticate, onInstalled });
    await waitFor(() => expect(onAuthenticate).toHaveBeenCalledWith('search'));
    view.unmount();
    await act(async () => { authenticate(); });
    expect(onInstalled).not.toHaveBeenCalled();
    expect(installMcpRecommendationMock).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(modelService.tryLoadModels).mockReset().mockResolvedValue([{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }] as never);
  });

  it('waits for the saved model before researching with Enter', async () => {
    let finishLoading!: (models: Awaited<ReturnType<typeof modelService.tryLoadModels>>) => void;
    jest.mocked(modelService.tryLoadModels).mockImplementationOnce(() => new Promise(resolve => { finishLoading = resolve; }));
    researchMcpConnectionMock.mockResolvedValue(result);
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    const request = screen.getByLabelText(/one thing to connect/i);
    fireEvent.change(request, { target: { value: 'connect my accounting app' } });
    expect(screen.getByRole('button', { name: /find included options/i })).toBeDisabled();
    fireEvent.keyDown(request, { key: 'Enter' });
    expect(researchMcpConnectionMock).not.toHaveBeenCalled();
    expect(request).toHaveValue('connect my accounting app');

    await act(async () => { finishLoading([{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }] as never); });
    expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled();
    fireEvent.keyDown(request, { key: 'Enter' });
    await screen.findByText(result.summary);
    expect(researchMcpConnectionMock).toHaveBeenCalledTimes(1);
    expect(researchMcpConnectionMock).toHaveBeenCalledWith(
      { query: 'connect my accounting app', modelId: 'model-1' }, expect.any(Function), expect.any(AbortSignal),
    );
  });

  it.each(['in the same update', 'while loading'])('waits for the model retry before researching with Enter %s', async timing => {
    let finishLoading!: (models: Awaited<ReturnType<typeof modelService.tryLoadModels>>) => void;
    jest.mocked(modelService.tryLoadModels)
      .mockRejectedValueOnce(new Error('Temporary connection failure'))
      .mockImplementationOnce(() => new Promise(resolve => { finishLoading = resolve; }));
    researchMcpConnectionMock.mockResolvedValue(result);
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    const request = screen.getByLabelText(/one thing to connect/i);
    fireEvent.change(request, { target: { value: 'connect my accounting app' } });
    const retry = await screen.findByRole('button', { name: /try again/i });
    if (timing === 'in the same update') {
      act(() => {
        fireEvent.click(retry);
        fireEvent.keyDown(request, { key: 'Enter' });
      });
    } else {
      fireEvent.click(retry);
      await waitFor(() => expect(modelService.tryLoadModels).toHaveBeenCalledTimes(2));
      fireEvent.keyDown(request, { key: 'Enter' });
    }
    expect(researchMcpConnectionMock).not.toHaveBeenCalled();
    expect(request).toHaveValue('connect my accounting app');
    expect(screen.getByRole('button', { name: /find included options/i })).toBeDisabled();

    await act(async () => { finishLoading([{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }] as never); });
    fireEvent.keyDown(request, { key: 'Enter' });
    await screen.findByText(result.summary);
    expect(researchMcpConnectionMock).toHaveBeenCalledTimes(1);
    expect(researchMcpConnectionMock).toHaveBeenCalledWith(
      { query: 'connect my accounting app', modelId: 'model-1' }, expect.any(Function), expect.any(AbortSignal),
    );
  });

  it('allows Enter to find included options after an empty model load completes', async () => {
    jest.mocked(modelService.tryLoadModels).mockResolvedValueOnce([]);
    researchMcpConnectionMock.mockResolvedValue(result);
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
    </ThemeProvider>);
    await screen.findByText(/no saved AI is available for this search/i);
    const request = screen.getByLabelText(/one thing to connect/i);
    fireEvent.change(request, { target: { value: 'work with local files' } });
    expect(screen.getByRole('button', { name: /find included options/i })).toBeEnabled();
    fireEvent.keyDown(request, { key: 'Enter' });
    await screen.findByText(result.summary);
    expect(researchMcpConnectionMock).toHaveBeenCalledTimes(1);
    expect(researchMcpConnectionMock).toHaveBeenCalledWith(
      { query: 'work with local files', modelId: '' }, expect.any(Function), expect.any(AbortSignal),
    );
  });

  it('retries a failed model load without losing the request or remounting', async () => {
    jest.mocked(modelService.tryLoadModels).mockRejectedValueOnce(new Error('Temporary connection failure'));
    researchMcpConnectionMock.mockResolvedValue(result);
    const onManual = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={onManual} />
    </ThemeProvider>);
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'free web search' } });
    await screen.findByRole('button', { name: /try again/i });
    expect(screen.getByRole('button', { name: /find included options/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /set up myself/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    expect(screen.getByLabelText(/one thing to connect/i)).toHaveValue('free web search');
    expect(modelService.tryLoadModels).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Your saved AI choices couldn’t load.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
    await waitFor(() => expect(researchMcpConnectionMock).toHaveBeenCalledWith(
      { query: 'free web search', modelId: 'model-1' }, expect.any(Function), expect.any(AbortSignal),
    ));
  });

  describe('real model request recovery', () => {
    const originalFetch = global.fetch;

    function modelResponse(status: number, models: unknown): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => models,
      } as unknown as Response;
    }

    beforeEach(() => {
      // Exercise the actual service's failure-to-null behavior, rather than
      // teaching the component test a rejection that loadModels never returns.
      const actual = jest.requireActual<typeof import('@/frontend/services/model')>('@/frontend/services/model');
      jest.mocked(modelService.tryLoadModels).mockImplementation(actual.modelService.tryLoadModels.bind(actual.modelService));
      jest.mocked(modelService.loadModels).mockImplementation(actual.modelService.loadModels.bind(actual.modelService));
    });

    afterEach(() => { global.fetch = originalFetch; });

    it.each(['unavailable', 'invalid response', 'network failure'])('shows a truthful failure and retries an %s model request', async failure => {
      const fetchMock = jest.fn();
      if (failure === 'unavailable') {
        fetchMock.mockResolvedValueOnce(modelResponse(503, { error: 'Temporarily unavailable' }));
      } else if (failure === 'invalid response') {
        fetchMock.mockResolvedValueOnce(modelResponse(200, { error: 'Not a model list' }));
      } else {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      }
      fetchMock.mockResolvedValue(modelResponse(200, [{ id: 'model-1', name: 'Research model', ApiKey: 'configured' }]));
      global.fetch = fetchMock;
      researchMcpConnectionMock.mockResolvedValue(result);
      render(<ThemeProvider theme={createTheme()}>
        <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
      </ThemeProvider>);
      const request = screen.getByLabelText(/one thing to connect/i);
      fireEvent.change(request, { target: { value: 'connect my accounting app' } });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Your saved AI choices couldn’t load.');
      expect(alert).not.toHaveTextContent(/no saved AI is available for this search/i);
      expect(screen.getByRole('button', { name: /find included options/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /set up myself/i })).toBeEnabled();
      expect(researchMcpConnectionMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith('/api/model', undefined);

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
      expect(request).toHaveValue('connect my accounting app');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(request, { key: 'Enter' });
      await screen.findByText(result.summary);
      expect(researchMcpConnectionMock).toHaveBeenCalledTimes(1);
      expect(researchMcpConnectionMock).toHaveBeenCalledWith(
        { query: 'connect my accounting app', modelId: 'model-1' }, expect.any(Function), expect.any(AbortSignal),
      );
    });

    it('keeps a real empty model response usable for bundled lookup', async () => {
      global.fetch = jest.fn().mockResolvedValue(modelResponse(200, []));
      researchMcpConnectionMock.mockResolvedValue(result);
      render(<ThemeProvider theme={createTheme()}>
        <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
      </ThemeProvider>);
      expect(await screen.findByRole('alert')).toHaveTextContent(/no saved AI is available for this search/i);
      expect(screen.queryByText('Your saved AI choices couldn’t load.')).not.toBeInTheDocument();
      const request = screen.getByLabelText(/one thing to connect/i);
      fireEvent.change(request, { target: { value: 'work with local files' } });
      fireEvent.keyDown(request, { key: 'Enter' });
      await screen.findByText(result.summary);
      expect(researchMcpConnectionMock).toHaveBeenCalledWith(
        { query: 'work with local files', modelId: '' }, expect.any(Function), expect.any(AbortSignal),
      );
    });

    it('keeps bundled lookup usable after a real model request failure', async () => {
      global.fetch = jest.fn().mockResolvedValue(modelResponse(503, { error: 'Temporarily unavailable' }));
      researchMcpConnectionMock.mockResolvedValue(result);
      render(<ThemeProvider theme={createTheme()}>
        <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={jest.fn()} />
      </ThemeProvider>);
      expect(await screen.findByRole('alert')).toHaveTextContent('Your saved AI choices couldn’t load.');
      const request = screen.getByLabelText(/one thing to connect/i);
      fireEvent.change(request, { target: { value: 'work with local files' } });
      fireEvent.keyDown(request, { key: 'Enter' });
      await screen.findByText(result.summary);
      expect(researchMcpConnectionMock).toHaveBeenCalledWith(
        { query: 'work with local files', modelId: '' }, expect.any(Function), expect.any(AbortSignal),
      );
    });
  });

  it('offers manual setup when no models are configured', async () => {
    jest.mocked(modelService.tryLoadModels).mockResolvedValueOnce([]);
    const onManual = jest.fn();
    render(<ThemeProvider theme={createTheme()}>
      <McpAiConnectionPanel onInstalled={jest.fn()} onAuthenticate={jest.fn()} onManual={onManual} />
    </ThemeProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /set up myself/i }));
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
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));
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

  it.each(['oauth-cimd', 'oauth-dcr'] as const)('does not request an Authorization credential for an %s recommendation', async authMode => {
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
        authMode,
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
    await waitFor(() => expect(screen.getByRole('button', { name: /find options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /find options/i }));

    expect(await screen.findByLabelText(/connection name/i)).toHaveValue('paypal');
    expect(screen.queryByLabelText(/^Authorization$/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/approve saving and connecting/i));
    const installButton = screen.getByRole('button', { name: /install and connect/i });
    expect(installButton).toBeEnabled();
    fireEvent.click(installButton);

    await waitFor(() => expect(installMcpRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'paypal',
      inputs: {},
      authMode,
    })));
  });
});
