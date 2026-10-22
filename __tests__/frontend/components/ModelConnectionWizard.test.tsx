import React from 'react';
import { ReadableStream } from 'node:stream/web';
import { TextDecoder } from 'node:util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const originalFetch = global.fetch;
const originalTextDecoder = global.TextDecoder;

function installerResponse(tool: string, success: boolean): Response {
  const events = Buffer.from([
    JSON.stringify({ type: 'stdout', data: `${tool} installer output` }),
    JSON.stringify({ type: 'result', success, error: success ? undefined : 'fixture installation failed' }),
  ].join('\n') + '\n');
  return {
    ok: true,
    body: new ReadableStream({ start(controller) { controller.enqueue(events); controller.close(); } }),
  } as unknown as Response;
}

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
  const view = render(
    <ThemeProvider theme={createTheme()}>
      <ModelConnectionWizard {...props} />
    </ThemeProvider>,
  );
  return { ...props, setOpen: (open: boolean) => view.rerender(<ThemeProvider theme={createTheme()}><ModelConnectionWizard {...props} open={open} /></ThemeProvider>) };
}

describe('ModelConnectionWizard', () => {
  it('uses bundled Codex and discovers a real model count before creation', async () => {
    const command = "& 'C:\\Program Files\\FLUJO\\codex.exe' login";
    (global.fetch as jest.Mock).mockImplementation((url: string) => Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () =>
      url.includes('/api/setup/ai-cli') ? { platform: 'win32', installMode: 'npm', oneClickInstall: true, codex: { bundled: true, loginCommand: command } }
        : { models: [{ id: 'gpt-6-luna', name: 'gpt-6-luna', contextWindow: 280000 }], success: true } }));
    const { onCreateModels } = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'ChatGPT / Codex' }).closest('button')!);
    expect(await screen.findByText(command)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install with WinGet' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Create my 0 models/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /completed the Codex browser sign-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /Find my Codex models/i }));
    expect(await screen.findByText('gpt-6-luna')).toBeInTheDocument();
    expect(onCreateModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Create my model/i }));
    await waitFor(() => expect(onCreateModels).toHaveBeenCalledTimes(1));
    expect((onCreateModels as jest.Mock).mock.calls[0][0]).toEqual([expect.objectContaining({ name: 'gpt-6-luna', adapter: 'codex-cli', ApiKey: '' })]);
  });

  it('retries a failed connection save without downloading the completed Ollama model again', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((url: string) => Promise.resolve(url === '/api/local-models/pull'
      ? installerResponse('fixture-model', true)
      : { ok: true, json: async () => url === '/api/local-models/capability'
        ? { enabled: true, ollamaReachable: true, ollamaUrl: 'http://localhost:11434', platform: 'win32', suggestedModel: 'fixture-model', installedModels: [] }
        : { platform: 'win32', installMode: 'git', oneClickInstall: true } }));
    let attempts = 0;
    const onCreateModels = jest.fn(async (models: Model[]) => ++attempts === 1
      ? { success: false, created: [], existing: [], error: 'Connection save interrupted' }
      : { success: true, created: models, existing: [] });
    renderWizard({ onCreateModels });
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: /^Offline$/i }).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Download fixture-model and connect' }));
    expect(await screen.findByText('Connection save interrupted')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveFocus();
    const retry = screen.getByRole('button', { name: 'Connect fixture-model' });
    expect(retry).toBeEnabled();
    expect(screen.getByText('Ollama is ready and this model is already downloaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('heading', { name: /^Offline$/i }).closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Connect fixture-model' }));
    expect(await screen.findByRole('heading', { name: /AI connections saved/i })).toHaveFocus();
    expect(onCreateModels).toHaveBeenCalledTimes(2);
    expect(onCreateModels.mock.calls[1][0]).toEqual([expect.objectContaining({
      provider: 'ollama', name: 'fixture-model', baseUrl: 'http://localhost:11434/v1',
    })]);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/local-models/pull')).toHaveLength(1);
  });

  it.each(['failed', 'missing result', 'broken stream'])('keeps the download retry after a %s Ollama pull', async (outcome) => {
    const fetchMock = global.fetch as jest.Mock;
    let pulls = 0;
    fetchMock.mockImplementation((url: string) => Promise.resolve(url === '/api/local-models/pull'
      ? ++pulls > 1 ? installerResponse('fixture-model', true)
        : outcome === 'failed' ? installerResponse('fixture-model', false)
          : { ok: true, body: new ReadableStream({ start(controller) {
            if (outcome === 'broken stream') controller.error(new Error('Download interrupted'));
            else { controller.enqueue(Buffer.from('{"type":"stdout","data":"still downloading"}\n')); controller.close(); }
          } }) }
      : { ok: true, json: async () => url === '/api/local-models/capability'
        ? { enabled: true, ollamaReachable: true, ollamaUrl: 'http://localhost:11434', platform: 'win32', suggestedModel: 'fixture-model', installedModels: [] }
        : { platform: 'win32', installMode: 'git', oneClickInstall: true } }));
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: /^Offline$/i }).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Download fixture-model and connect' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(props.onCreateModels).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Connect fixture-model' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download fixture-model and connect' }));
    expect(await screen.findByRole('heading', { name: /AI connections saved/i })).toHaveFocus();
    expect(pulls).toBe(2);
    expect(props.onCreateModels).toHaveBeenCalledTimes(1);
  });

  it('ignores a successful pull from a closed session when the wizard reopens', async () => {
    let complete!: (value: Response) => void;
    (global.fetch as jest.Mock).mockImplementation((url: string) => url === '/api/local-models/pull'
      ? new Promise<Response>(resolve => { complete = resolve; })
      : Promise.resolve({ ok: true, json: async () => url === '/api/local-models/capability'
        ? { enabled: true, ollamaReachable: true, ollamaUrl: 'http://localhost:11434', platform: 'win32', suggestedModel: 'fixture-model', installedModels: [] }
        : { platform: 'win32', installMode: 'git', oneClickInstall: true } }));
    const props = renderWizard();
    const chooseLocal = () => {
      fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
      fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
      fireEvent.click(screen.getByRole('heading', { name: /^Offline$/i }).closest('button')!);
    };
    chooseLocal();
    fireEvent.click(await screen.findByRole('button', { name: 'Download fixture-model and connect' }));
    props.setOpen(false);
    props.setOpen(true);
    chooseLocal();
    await act(async () => complete(installerResponse('fixture-model', true)));
    expect(await screen.findByRole('button', { name: 'Download fixture-model and connect' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Connect fixture-model' })).not.toBeInTheDocument();
    expect(props.onCreateModels).not.toHaveBeenCalled();
  });

  it('focuses and names each new question immediately, including Back and reopening', () => {
    const props = renderWizard();
    const expectQuestion = () => {
      const heading = screen.getAllByRole('heading')[0];
      expect(heading).toHaveFocus();
      expect(screen.getByRole('dialog')).toHaveAccessibleName(heading.textContent!);
    };
    expectQuestion();
    const choice = screen.getByRole('button', { name: /no idea/i });
    choice.focus();
    fireEvent.click(choice);
    expectQuestion();
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    expectQuestion();
    const back = screen.getByRole('button', { name: 'Back' });
    back.focus();
    fireEvent.click(back);
    expectQuestion();
    props.setOpen(false);
    props.setOpen(true);
    expectQuestion();
  });

  it('keeps typing focus on rerenders and announces the saved result', async () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    fireEvent.click(screen.getByRole('heading', { name: 'OpenRouter' }).closest('button')!);
    const key = screen.getByLabelText('OpenRouter API key', { exact: true });
    key.focus();
    fireEvent.change(key, { target: { value: 'sk-or-test' } });
    expect(key).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    const heading = await screen.findByRole('heading', { name: /AI connections saved/i });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(heading.textContent!);
  });

  it('does not let an old save completion unlock a new pending save', async () => {
    const completions: Array<(value: { success: boolean; created: Model[]; existing: Model[] }) => void> = [];
    const onCreateModels = jest.fn((_models: Model[]) => new Promise<{ success: boolean; created: Model[]; existing: Model[] }>(resolve => completions.push(resolve)));
    const props = renderWizard({ onCreateModels });
    const save = () => {
      fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
      fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
      fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
      fireEvent.click(screen.getByRole('heading', { name: 'OpenRouter' }).closest('button')!);
      fireEvent.change(screen.getByLabelText('OpenRouter API key', { exact: true }), { target: { value: 'sk-or-test' } });
      fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    };
    save();
    props.setOpen(false);
    props.setOpen(true);
    save();
    expect(onCreateModels).toHaveBeenCalledTimes(2);
    await act(async () => completions[0]({ success: true, created: onCreateModels.mock.calls[0][0], existing: [] }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.queryByText(/AI connections saved/i)).not.toBeInTheDocument();
    await act(async () => completions[1]({ success: true, created: onCreateModels.mock.calls[1][0], existing: [] }));
    expect(await screen.findByText(/AI connections saved/i)).toBeInTheDocument();
  });

  it('locks Back during a model pull and ignores its failure after reopening', async () => {
    let complete!: (value: Response) => void;
    (global.fetch as jest.Mock).mockImplementation((url: string) => url === '/api/local-models/pull'
      ? new Promise<Response>(resolve => { complete = resolve; })
      : Promise.resolve({ ok: true, json: async () => url === '/api/local-models/capability'
        ? { enabled: true, ollamaReachable: true, ollamaUrl: 'http://localhost:11434', platform: 'win32', suggestedModel: 'fixture-model', installedModels: [] }
        : { platform: 'win32', installMode: 'git', oneClickInstall: true } }));
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: /^Offline$/i }).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Download fixture-model and connect' }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    props.setOpen(false);
    props.setOpen(true);
    await act(async () => complete({ ok: false } as Response));
    expect(screen.getByRole('button', { name: /no idea/i })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(props.onCreateModels).not.toHaveBeenCalled();
  });

  it('ignores an old Ollama capability response after reopening', async () => {
    let complete!: (value: Response) => void;
    let capabilityCalls = 0;
    (global.fetch as jest.Mock).mockImplementation((url: string) => url === '/api/local-models/capability'
      ? ++capabilityCalls === 1 ? new Promise<Response>(resolve => { complete = resolve; })
        : Promise.resolve({ ok: true, json: async () => ({ enabled: true, ollamaReachable: true, ollamaUrl: 'http://localhost:11434', platform: 'win32', suggestedModel: 'current-model', installedModels: ['current-model'] }) })
      : Promise.resolve({ ok: true, json: async () => ({ platform: 'win32', installMode: 'git', oneClickInstall: true }) }));
    const props = renderWizard();
    const chooseLocal = () => {
      fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
      fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
      fireEvent.click(screen.getByRole('heading', { name: /^Offline$/i }).closest('button')!);
    };
    chooseLocal();
    await waitFor(() => expect(capabilityCalls).toBe(1));
    props.setOpen(false);
    props.setOpen(true);
    chooseLocal();
    expect(await screen.findByRole('button', { name: 'Connect current-model' })).toBeEnabled();
    await act(async () => complete({ ok: true, json: async () => ({ enabled: true, ollamaReachable: true, ollamaUrl: 'http://old:11434', platform: 'win32', suggestedModel: 'obsolete-model', installedModels: ['obsolete-model'] }) } as Response));
    expect(screen.getByRole('button', { name: 'Connect current-model' })).toBeEnabled();
    expect(screen.queryByText(/obsolete-model/)).not.toBeInTheDocument();
  });

  it('ignores a saved result from a closed wizard session', async () => {
    let complete!: (value: { success: boolean; created: Model[]; existing: Model[] }) => void;
    const onCreateModels = jest.fn((_models: Model[]) => new Promise<{ success: boolean; created: Model[]; existing: Model[] }>(resolve => { complete = resolve; }));
    const props = renderWizard({ onCreateModels });
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    fireEvent.click(screen.getByRole('heading', { name: 'OpenRouter' }).closest('button')!);
    fireEvent.change(screen.getByLabelText('OpenRouter API key', { exact: true }), { target: { value: 'sk-or-test' } });
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    await waitFor(() => expect(onCreateModels).toHaveBeenCalledTimes(1));
    props.setOpen(false);
    props.setOpen(true);
    await act(async () => complete({ success: true, created: onCreateModels.mock.calls[0][0], existing: [] }));
    expect(screen.getByRole('button', { name: /no idea/i })).toBeEnabled();
    expect(screen.queryByText(/AI connections saved/i)).not.toBeInTheDocument();
  });

  it('keeps Back disabled during a pending CLI installation', async () => {
    let complete!: (value: Response) => void;
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise<Response>(resolve => { complete = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ platform: 'win32', installMode: 'git', oneClickInstall: true }) }));
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: /ChatGPT/i }).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Install with WinGet' }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await act(async () => complete({ ok: false, json: async () => ({ error: 'fixture install unavailable' }) } as Response));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());
  });

  it.each([
    ['Claude', 'ChatGPT / Codex', 'claude', true],
    ['ChatGPT / Codex', 'Claude', 'codex', true],
    ['Claude', 'ChatGPT / Codex', 'claude', false],
    ['ChatGPT / Codex', 'Claude', 'codex', false],
  ] as const)('clears the %s installation receipt when switching to %s (installer: %s, success: %s)', async (previous, next, tool, success) => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => Promise.resolve(options?.method === 'POST'
      ? installerResponse(tool, success)
      : { ok: true, json: async () => ({ platform: 'win32', installMode: 'git', oneClickInstall: true }) }));
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: previous }).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Install with WinGet' }));
    expect(await screen.findByText(`${tool} installer output`)).toBeInTheDocument();
    if (success) expect(await screen.findByText('Installed. Continue with the sign-in command below.')).toBeInTheDocument();
    else expect(await screen.findByText('fixture installation failed')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('heading', { name: next }).closest('button')!);
    expect(screen.queryByText('Installed. Continue with the sign-in command below.')).not.toBeInTheDocument();
    expect(screen.queryByText(`${tool} installer output`)).not.toBeInTheDocument();
    expect(screen.queryByText('fixture installation failed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install with WinGet' })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([
      ['/api/setup/ai-cli', expect.objectContaining({ body: JSON.stringify({ tool }) })],
    ]);
    expect(props.onCreateModels).not.toHaveBeenCalled();
  });

  it.each([
    ['Claude', 'claude'],
    ['ChatGPT / Codex', 'codex'],
  ])('keeps the completed %s installation receipt when returning to the same setup', async (provider, tool) => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => Promise.resolve(options?.method === 'POST'
      ? installerResponse(tool, true)
      : { ok: true, json: async () => ({ platform: 'win32', installMode: 'git', oneClickInstall: true }) }));
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /I already subscribe/i }));
    fireEvent.click(screen.getByRole('heading', { name: provider }).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Install with WinGet' }));
    expect(await screen.findByText('Installed. Continue with the sign-in command below.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('heading', { name: provider }).closest('button')!);
    expect(screen.getByText('Installed. Continue with the sign-in command below.')).toBeInTheDocument();
    expect(screen.getByText(`${tool} installer output`)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('keeps the selected setup visible while its model save is pending', async () => {
    let complete!: (value: { success: boolean; created: Model[]; existing: Model[] }) => void;
    const onCreateModels = jest.fn((_models: Model[]) => new Promise<{ success: boolean; created: Model[]; existing: Model[] }>(resolve => { complete = resolve; }));
    renderWizard({ onCreateModels });
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    fireEvent.click(screen.getByRole('heading', { name: 'OpenRouter' }).closest('button')!);
    fireEvent.change(screen.getByLabelText('OpenRouter API key', { exact: true }), { target: { value: 'sk-or-test' } });
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    await waitFor(() => expect(onCreateModels).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await act(async () => complete({ success: true, created: onCreateModels.mock.calls[0][0], existing: [] }));
    expect(await screen.findByText(/AI connections saved/i)).toBeInTheDocument();
  });

  beforeEach(() => {
    global.TextDecoder = TextDecoder as typeof global.TextDecoder;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ platform: 'win32', installMode: 'git', oneClickInstall: true }) } as Response));
  });
  afterEach(() => { global.fetch = originalFetch; global.TextDecoder = originalTextDecoder; });

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

  it.each([
    ['OpenRouter', 'Requesty', 'requesty'],
    ['Requesty', 'OpenRouter', 'openrouter'],
  ])('clears the %s key when switching to %s and requires its own key before saving', async (previous, next, provider) => {
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    fireEvent.click(screen.getByRole('heading', { name: previous }).closest('button')!);
    fireEvent.change(screen.getByLabelText(`${previous} API key`, { exact: true }), { target: { value: 'previous-provider-key' } });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('heading', { name: next }).closest('button')!);
    const key = screen.getByLabelText(`${next} API key`, { exact: true });
    expect(key).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    expect(props.onCreateModels).not.toHaveBeenCalled();
    expect(screen.getByText('Paste your API key first.')).toBeInTheDocument();

    fireEvent.change(key, { target: { value: 'next-provider-key' } });
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const models = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider, ApiKey: 'next-provider-key' });
  });

  it.each(['OpenRouter', 'Requesty'])('keeps the %s key when returning to the same setup', async (provider) => {
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /let’s start free/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Online' }).closest('button')!);
    fireEvent.click(screen.getByRole('heading', { name: provider }).closest('button')!);
    fireEvent.change(screen.getByLabelText(`${provider} API key`, { exact: true }), { target: { value: 'same-provider-key' } });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('heading', { name: provider }).closest('button')!);
    expect(screen.getByLabelText(`${provider} API key`, { exact: true })).toHaveValue('same-provider-key');
    fireEvent.click(screen.getByRole('button', { name: /create my model/i }));
    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    expect((props.onCreateModels as jest.Mock).mock.calls[0][0]).toEqual([
      expect.objectContaining({ provider: provider.toLowerCase(), ApiKey: 'same-provider-key' }),
    ]);
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
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => url === '/api/model/provider'
      ? { models: [{ id: 'gemini-new-model', name: 'New Gemini model' }] }
      : { platform: 'win32', installMode: 'git', oneClickInstall: true } }));
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
    expect(screen.getByText('& "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/FLUJO handles CLI setup automatically/)).toBeInTheDocument();
    expect(screen.getByText(/Personal Google accounts can use Antigravity/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account plans and model availability' })).toHaveAttribute('href', 'https://antigravity.google/docs/plans/');
    expect(screen.queryByRole('button', { name: 'Install with WinGet' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Gemini API key')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /connect Antigravity models/i }));
    expect(props.onCreateModels).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a Gemini API key, or confirm Antigravity account sign-in/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /completed Antigravity account sign-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /connect Antigravity models/i }));
    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const models = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(models.map(model => model.name)).toEqual(['default', 'gemini-new-model']);
    expect(models.every(model => model.provider === 'antigravity-cli' && model.adapter === 'antigravity-cli' && model.ApiKey === '')).toBe(true);
  });

  it('creates Antigravity CLI API-key models without requiring an account login confirmation', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => url === '/api/model/provider'
      ? { models: [{ id: 'gemini-new-model', name: 'New Gemini model' }] }
      : { platform: 'win32', installMode: 'git', oneClickInstall: true } }));
    const props = renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /no idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /i can pay/i }));
    fireEvent.click(screen.getByRole('heading', { name: 'Antigravity CLI' }).closest('button')!);
    fireEvent.change(screen.getByLabelText('Gemini API key'), { target: { value: '  gemini-api-test  ' } });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('Antigravity CLI Default')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /connect Antigravity models/i }));
    await waitFor(() => expect(props.onCreateModels).toHaveBeenCalledTimes(1));
    const models = (props.onCreateModels as jest.Mock).mock.calls[0][0] as Model[];
    expect(models.map(model => model.name)).toEqual(['default', 'gemini-new-model']);
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
