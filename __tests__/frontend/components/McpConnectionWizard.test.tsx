import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import McpConnectionWizard from '@/frontend/components/mcp/MCPServerManager/McpConnectionWizard';

jest.mock('@/frontend/services/model', () => ({
  modelService: { loadModels: jest.fn(async () => [{ id: 'model-1', name: 'Research model' }]) },
}));

const researchMock = jest.fn();
const installMock = jest.fn();
jest.mock('@/frontend/services/mcp/assistant', () => ({
  researchMcpConnection: (...args: unknown[]) => researchMock(...args),
  installMcpRecommendation: (...args: unknown[]) => installMock(...args),
}));
const recommendation = {
  summary: 'Reviewed search', recommendedId: 'search', sources: [],
  candidates: [{ id: 'search', title: 'Search', registryName: 'search', description: 'Search',
    plan: { transport: 'streamable', serverName: 'search', serverUrl: 'https://example.com/mcp' },
    authMode: 'none', reasons: [], warnings: [], requiredInputs: [], freeNote: 'Free' }],
};

async function beginInstall() {
  fireEvent.click(screen.getByRole('button', { name: /ai-assisted/i }));
  fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'search' } });
  await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /research options/i }));
  fireEvent.click(await screen.findByLabelText(/approve saving and connecting/i));
  fireEvent.click(screen.getByRole('button', { name: /install and connect/i }));
}

function renderWizard(overrides?: Partial<React.ComponentProps<typeof McpConnectionWizard>>) {
  const props: React.ComponentProps<typeof McpConnectionWizard> = {
    open: true,
    onClose: jest.fn(),
    onChooseSetup: jest.fn(),
    onManualCreation: jest.fn(),
    onInstalled: jest.fn(),
    onAuthenticate: jest.fn(async () => undefined),
    ...overrides,
  };

  render(
    <ThemeProvider theme={createTheme()}>
      <McpConnectionWizard {...props} />
    </ThemeProvider>,
  );

  return props;
}

describe('McpConnectionWizard', () => {
  it('focuses and names new questions immediately when moving forward or Back', () => {
    renderWizard();
    const expectQuestion = () => {
      const heading = screen.getAllByRole('heading')[0];
      expect(heading).toHaveFocus();
      expect(screen.getByRole('dialog')).toHaveAccessibleName(heading.textContent!);
    };
    expectQuestion();
    const choose = screen.getByRole('button', { name: /help me choose/i });
    choose.focus();
    fireEvent.click(choose);
    expectQuestion();
    fireEvent.click(screen.getByRole('button', { name: /custom app/i }));
    expectQuestion();
    const back = screen.getByRole('button', { name: /back/i });
    back.focus();
    fireEvent.click(back);
    expectQuestion();
  });

  it('preserves the assisted search autofocus and typing while naming its current step', async () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /ai-assisted/i }));
    const input = screen.getByLabelText(/one thing to connect/i);
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'search' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    expect(input).toHaveFocus();
    const heading = screen.getAllByRole('heading')[0];
    expect(screen.getByRole('dialog')).toHaveAccessibleName(heading.textContent!);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    researchMock.mockResolvedValue(recommendation);
  });

  it('blocks Back, Close, and Escape throughout installation and authentication', async () => {
    let finishInstall!: (value: unknown) => void;
    let finishAuthentication!: () => void;
    installMock.mockImplementation(() => new Promise((resolve) => { finishInstall = resolve; }));
    const props = renderWizard({ onAuthenticate: jest.fn(() => new Promise<void>((resolve) => { finishAuthentication = resolve; })) });
    await beginInstall();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    const close = screen.getByRole('button', { name: /^close$/i });
    expect(close).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => { finishInstall({ installed: true, serverName: 'search', needsAuthentication: true }); });
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    await act(async () => { finishAuthentication(); });
    expect(props.onInstalled).toHaveBeenCalledWith('search');
    expect(close).toBeEnabled();
  });

  it('discards old authentication completion after externally closing and reopening', async () => {
    let finishAuthentication!: () => void;
    installMock.mockResolvedValue({ installed: true, serverName: 'search', needsAuthentication: true });
    const props = {
      open: true, onClose: jest.fn(), onChooseSetup: jest.fn(), onManualCreation: jest.fn(), onInstalled: jest.fn(),
      onAuthenticate: jest.fn(() => new Promise<void>((resolve) => { finishAuthentication = resolve; })),
    };
    const view = render(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} /></ThemeProvider>);
    await beginInstall();
    await waitFor(() => expect(props.onAuthenticate).toHaveBeenCalledTimes(1));
    view.rerender(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} open={false} /></ThemeProvider>);
    view.rerender(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} /></ThemeProvider>);
    await act(async () => { finishAuthentication(); });
    expect(props.onInstalled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /ai-assisted/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeEnabled();
  });

  it('keeps a reopened installation busy when the old installation finishes', async () => {
    const finishes: Array<(value: unknown) => void> = [];
    installMock.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    const props = { open: true, onClose: jest.fn(), onChooseSetup: jest.fn(), onManualCreation: jest.fn(),
      onInstalled: jest.fn(), onAuthenticate: jest.fn(async () => undefined) };
    const view = render(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} /></ThemeProvider>);
    await beginInstall();
    view.rerender(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} open={false} /></ThemeProvider>);
    view.rerender(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} /></ThemeProvider>);
    await beginInstall();
    await act(async () => { finishes[0]({ installed: true, serverName: 'old', needsAuthentication: true }); });
    expect(props.onAuthenticate).not.toHaveBeenCalled();
    expect(props.onInstalled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    await act(async () => { finishes[1]({ installed: true, serverName: 'new' }); });
    expect(props.onInstalled).toHaveBeenCalledWith('new');
    expect(screen.getByRole('button', { name: /back/i })).toBeEnabled();
  });

  it('ignores research progress and results from the closed session even when abort is ignored', async () => {
    let finishOld!: (value: unknown) => void;
    let oldProgress!: (event: unknown) => void;
    researchMock.mockImplementationOnce((_input, progress) => {
      oldProgress = progress;
      return new Promise((resolve) => { finishOld = resolve; });
    });
    const props = { open: true, onClose: jest.fn(), onChooseSetup: jest.fn(), onManualCreation: jest.fn(),
      onInstalled: jest.fn(), onAuthenticate: jest.fn(async () => undefined) };
    const view = render(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /ai-assisted/i }));
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'old request' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /research options/i }));
    view.rerender(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} open={false} /></ThemeProvider>);
    view.rerender(<ThemeProvider theme={createTheme()}><McpConnectionWizard {...props} /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /ai-assisted/i }));
    fireEvent.change(screen.getByLabelText(/one thing to connect/i), { target: { value: 'new request' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /research options/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /research options/i }));
    await screen.findByText('Reviewed search');
    await act(async () => {
      oldProgress({ type: 'progress', message: 'Obsolete progress' });
      finishOld({ ...recommendation, summary: 'Obsolete result' });
    });
    expect(screen.queryByText('Obsolete progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Obsolete result')).not.toBeInTheDocument();
    expect(screen.getByText('Reviewed search')).toBeInTheDocument();
    expect(researchMock.mock.calls[0][2].aborted).toBe(true);
  });
  it('sends experts to the complete manual setup', () => {
    const props = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /i’m an expert/i }));

    expect(props.onManualCreation).toHaveBeenCalledTimes(1);
    expect(props.onChooseSetup).not.toHaveBeenCalled();
  });

  it('guides a new user to the curated Spotlight setup', () => {
    const props = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /help me choose/i }));
    expect(screen.getByRole('heading', { name: /how would you like to find it/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /quick picks/i }));

    expect(props.onChooseSetup).toHaveBeenCalledWith('spotlight');
  });

  it('routes known remote connection details to the remote setup tab', () => {
    const props = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /i have connection details/i }));
    expect(screen.getByRole('heading', { name: /where does the app run/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /at a remote url/i }));

    expect(props.onChooseSetup).toHaveBeenCalledWith('remote');
  });

  it('opens the single-prompt AI-assisted connection mode', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /ai-assisted/i }));

    expect(screen.getByRole('heading', { name: /what do you want to connect/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/one thing to connect/i)).toBeInTheDocument();
  });
});
