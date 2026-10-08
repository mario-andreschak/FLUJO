import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import McpConnectionWizard from '@/frontend/components/mcp/MCPServerManager/McpConnectionWizard';

jest.mock('@/frontend/services/model', () => ({
  modelService: { loadModels: jest.fn(async () => []) },
}));

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
