import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({
  __esModule: true,
  default: () => null,
}));

import ModelConnectionWizard from '@/frontend/components/models/ModelConnectionWizard';
import { Model } from '@/shared/types';

function renderWizard(overrides?: Partial<React.ComponentProps<typeof ModelConnectionWizard>>) {
  const onCreateModels = jest.fn(async (models: Model[]) => ({
    success: true,
    created: models,
    existing: [],
  }));
  const props: React.ComponentProps<typeof ModelConnectionWizard> = {
    open: true,
    onClose: jest.fn(),
    onManualCreation: jest.fn(),
    onCreateModels,
    ...overrides,
  };
  render(
    <ThemeProvider theme={createTheme()}>
      <ModelConnectionWizard {...props} />
    </ThemeProvider>,
  );
  return props;
}

describe('ModelConnectionWizard', () => {
  it('sends experts directly to manual creation', () => {
    const props = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /i’m an expert/i }));

    expect(props.onManualCreation).toHaveBeenCalledTimes(1);
    expect(props.onCreateModels).not.toHaveBeenCalled();
  });

  it('creates the exact OpenRouter free-router model through the beginner path', async () => {
    const props = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    fireEvent.click(screen.getByRole('heading', { name: 'OpenRouter' }).closest('button')!);

    expect(screen.getByText(/exact technical model openrouter\/free/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('OpenRouter API key', { exact: true }), { target: { value: 'sk-or-test' } });
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));

    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const models = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      name: 'openrouter/free',
      displayName: 'OpenRouter Free',
      provider: 'openrouter',
      ApiKey: 'sk-or-test',
    });
    expect(await screen.findByText(/your ai is ready to flow/i)).toBeInTheDocument();
  });

  it('shows the shorter path for users who already know a bit', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /i know a bit/i }));

    expect(screen.getByText(/pick the billing style/i)).toBeInTheDocument();
    expect(screen.queryByText(/free services are great for learning/i)).not.toBeInTheDocument();
  });

  it('creates an Azure deployment through the guided paid-provider path', async () => {
    const props = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /i can pay/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Azure OpenAI' }).closest('button')!);

    fireEvent.change(screen.getByLabelText(/Resource endpoint/i), {
      target: { value: 'https://team.openai.azure.com' },
    });
    fireEvent.change(screen.getByLabelText(/Deployment name/i), {
      target: { value: 'production-gpt' },
    });
    fireEvent.change(screen.getByLabelText('Azure OpenAI API key'), {
      target: { value: 'azure-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));

    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const [model] = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(model).toMatchObject({
      name: 'production-gpt',
      provider: 'azure',
      adapter: 'azure',
      baseUrl: 'https://team.openai.azure.com',
      azureApiVersion: '2024-10-21',
      ApiKey: 'azure-secret',
    });
  });
});
