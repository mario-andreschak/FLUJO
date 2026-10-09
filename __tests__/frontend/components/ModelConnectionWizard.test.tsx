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
import { ANTIGRAVITY_CLI_GUIDED_MODELS } from '@/shared/types/model/provider';

const originalFetch = global.fetch;

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
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ platform: 'win32', installMode: 'git', oneClickInstall: true }) } as Response));
  });
  afterEach(() => { global.fetch = originalFetch; });

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
    expect(await screen.findByText(/AI connections saved/i)).toBeInTheDocument();
    expect(screen.getByText(/These connections have not been tested/)).toHaveTextContent('Test model');
    expect(screen.queryByText(/your ai is ready to flow/i)).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith('/api/model/test', expect.anything());
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

  it.each(['subscription', 'free'] as const)('requires account login confirmation and creates Antigravity CLI models through %s setup', async route => {
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    if (route === 'subscription') {
      fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
      fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    }
    fireEvent.click(screen.getByRole('heading', { name: 'Antigravity CLI' }).closest('button')!);

    expect(await screen.findByText('irm https://antigravity.google/cli/install.ps1 | iex')).toBeInTheDocument();
    expect(screen.getByText('flujo-agy', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Optional standalone alternative/)).toBeInTheDocument();
    expect(screen.getByText(/Over SSH, open the printed authorization URL locally/)).toBeInTheDocument();
    expect(screen.getByText(/Personal Google accounts can use Antigravity/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account plans and model availability' })).toHaveAttribute('href', 'https://antigravity.google/docs/plans/');
    expect(screen.queryByRole('button', { name: 'Install with WinGet' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Gemini API key')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /create my(?: \d+)? models?/i }));
    expect(props.onCreateModels).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a Gemini API key, or confirm Antigravity account sign-in/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /completed Antigravity account sign-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /create my(?: \d+)? models?/i }));
    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const models = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(models.map(model => model.name)).toEqual([...ANTIGRAVITY_CLI_GUIDED_MODELS]);
    expect(models.every(model => model.provider === 'antigravity-cli' && model.adapter === 'antigravity-cli' && model.ApiKey === '')).toBe(true);
  });

  it('creates Antigravity CLI API-key models without requiring an account login confirmation', async () => {
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /i can pay/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Antigravity CLI' }).closest('button')!);
    fireEvent.change(screen.getByLabelText('Gemini API key'), { target: { value: '  gemini-api-test  ' } });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('Antigravity Gemini 3.8 Flash (Medium)')).toBeInTheDocument();
    expect(screen.getByText('Antigravity Gemini 3.1 Pro (High)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create my(?: \d+)? models?/i }));
    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const models = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(models.map(model => model.name)).toEqual(['default', 'gemini-3.8-flash-medium', 'gemini-3.1-pro-high']);
    expect(models.every(model => model.ApiKey === 'gemini-api-test' && model.adapter === 'antigravity-cli')).toBe(true);
  });

  it('does not reuse a Codex login confirmation for Antigravity CLI', () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'ChatGPT / Codex' }).closest('button')!);
    fireEvent.click(screen.getByRole('checkbox', { name: /completed the Codex browser sign-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    fireEvent.click(screen.getByRole('heading', { name: 'Antigravity CLI' }).closest('button')!);
    expect(screen.getByRole('checkbox', { name: /completed Antigravity account sign-in/i })).not.toBeChecked();
  });

  it.each([
    ['win32', 'git', 'irm https://antigravity.google/cli/install.ps1 | iex'],
    ['darwin', 'npm', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
    ['linux', 'git', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
    ['linux', 'container', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
  ])('shows official Antigravity instructions on the %s/%s host without a WinGet button', async (platform, installMode, installCommand) => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ platform, installMode, oneClickInstall: true }) });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /i know a bit/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Antigravity CLI' }).closest('button')!);
    expect(await screen.findByText(installCommand)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Official installation instructions' })).toHaveAttribute('href', 'https://antigravity.google/docs/cli/install/');
    expect(screen.queryByRole('button', { name: 'Install with WinGet' })).not.toBeInTheDocument();
    expect(screen.getByText(/same operating-system user.*native keyring or CLI credential cache/)).toBeInTheDocument();
  });

  it.each([
    ['win32', 'git', true, 'Windows'],
    ['darwin', 'npm', false, 'macOS'],
    ['linux', 'git', false, 'Linux'],
    ['linux', 'container', false, 'container'],
  ])('uses server-side %s/%s setup instructions', async (platform, installMode, oneClickInstall, label) => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ platform, installMode, oneClickInstall }) });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'ChatGPT / Codex' }).closest('button')!);
    expect(await screen.findByText(new RegExp(`(machine|runs in a).*${label}|${label} machine`, 'i'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Official installation instructions' })).toHaveAttribute('href', 'https://github.com/openai/codex#installation');
    if (oneClickInstall) {
      expect(screen.getByRole('button', { name: 'Install with WinGet' })).toBeEnabled();
    } else {
      expect(screen.queryByRole('button', { name: 'Install with WinGet' })).not.toBeInTheDocument();
      expect(screen.queryByText(/winget install/)).not.toBeInTheDocument();
    }
  });

  it('keeps official instructions available when host detection fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Claude' }).closest('button')!);
    expect(await screen.findByText(/operating system could not be identified/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install with WinGet' })).not.toBeInTheDocument();
  });
});

it('saves the OrcaRouter first-use connection with its own credentials and vendor/model ID', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ platform: 'win32' }) } as Response));
  const props = renderWizard();
  fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
  fireEvent.click(screen.getByRole('button', { name: /i can pay/i }));
  fireEvent.click(screen.getByRole('heading', { name: 'OrcaRouter' }).closest('button')!);
  expect(screen.getByText(/an OpenRouter key will not authenticate/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('OrcaRouter API key', { exact: true }), { target: { value: 'orca-fixture-key' } });
  fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
  await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
  expect((props.onCreateModels as jest.Mock).mock.calls[0][0]).toEqual([expect.objectContaining({ provider: 'orcarouter', adapter: 'openai', name: 'anthropic/claude-sonnet-4', ApiKey: 'orca-fixture-key', baseUrl: 'https://api.orcarouter.ai/v1' })]);
  global.fetch = originalFetch;
});
