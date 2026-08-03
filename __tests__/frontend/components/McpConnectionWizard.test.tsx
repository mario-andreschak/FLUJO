import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import McpConnectionWizard from '@/frontend/components/mcp/MCPServerManager/McpConnectionWizard';

function renderWizard(overrides?: Partial<React.ComponentProps<typeof McpConnectionWizard>>) {
  const props: React.ComponentProps<typeof McpConnectionWizard> = {
    open: true,
    onClose: jest.fn(),
    onChooseSetup: jest.fn(),
    onManualCreation: jest.fn(),
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
});
