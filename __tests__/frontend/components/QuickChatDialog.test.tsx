import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickChatDialog from '@/frontend/components/Chat/QuickChatDialog';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { AskFlujoProvider } from '@/frontend/contexts/AskFlujoContext';
import { LOCALE_STORAGE_KEY } from '@/frontend/i18n/locales';
import { translate } from '@/frontend/i18n/core';

const mockLoadModels = jest.fn();
const mockLoadServers = jest.fn();
const mockListTools = jest.fn();
const mockServerStatus = jest.fn();

jest.mock('next/navigation', () => ({ usePathname: () => '/' }));

jest.mock('@/frontend/services/model', () => ({
  modelService: {
    loadModels: (...args: unknown[]) => mockLoadModels(...args),
    tryLoadModels: (...args: unknown[]) => mockLoadModels(...args),
  },
}));

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => mockLoadServers(...args),
    listServerTools: (...args: unknown[]) => mockListTools(...args),
    getServerStatus: (...args: unknown[]) => mockServerStatus(...args),
  },
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const locales = [
  {
    locale: 'en',
    loadFailed: 'Could not load your setup.',
    toolsFailed: 'Could not load actions. Try again.',
  },
  {
    locale: 'es',
    loadFailed: 'No se pudo cargar tu configuración.',
    toolsFailed: 'No se pudieron cargar las acciones. Inténtalo de nuevo.',
  },
] as const;

const app = { name: 'Calendar', disabled: false };
const tools = [{ name: 'read_events', description: 'Read events', inputSchema: { type: 'object' } }];

function dialog(locale: string, initialModelId?: string, selectApps = true) {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const onStart = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();
  const content = (open: boolean) => (
    <I18nProvider>
      <AskFlujoProvider>
        <QuickChatDialog open={open} onClose={onClose} onStart={onStart} initialModelId={initialModelId} selectApps={selectApps} />
      </AskFlujoProvider>
    </I18nProvider>
  );
  // Let the provider restore the actual saved language before requesting lists.
  const view = render(content(false));
  view.rerender(content(true));
  return { ...view, onStart, setOpen: (open: boolean) => view.rerender(content(open)) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadModels.mockReset().mockResolvedValue([{ id: 'model-1', name: 'Friendly AI', provider: 'openai' }]);
  mockLoadServers.mockReset().mockResolvedValue([app]);
  mockListTools.mockReset().mockResolvedValue({ tools });
  mockServerStatus.mockReset().mockResolvedValue({ status: 'connected' });
});

it('starts ordinary Quick Chat without fetching or selecting apps or tool schemas', async () => {
  mockLoadServers.mockRejectedValue(new Error('An app inventory should not block starting a chat'));
  const view = dialog('en', undefined, false);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start chat' })).toBeEnabled());
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(mockLoadServers).not.toHaveBeenCalled();
  expect(mockListTools).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: translate('en', 'chat.quick.systemPrompt') }), { target: { value: 'Help me plan tomorrow.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  await waitFor(() => expect(view.onStart).toHaveBeenCalledWith({ modelId: 'model-1', servers: [], systemPrompt: 'Help me plan tomorrow.' }));
});

afterEach(() => window.localStorage.removeItem(LOCALE_STORAGE_KEY));

it('chooses an app-capable model when the preferred model cannot use tools', async () => {
  mockLoadModels.mockResolvedValue([
    { id: 'text', name: 'Text AI', supportsTools: false },
    { id: 'model-1', name: 'Friendly AI', supportsTools: true },
  ]);
  const view = dialog('en', 'text', false);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start chat' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  await waitFor(() => expect(view.onStart).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'model-1' })));
});

it.each(['en', 'es'] as const)('offers model connection recovery for an incompatible fallback policy in %s', async locale => {
  mockLoadModels.mockResolvedValue([
    { id: 'text', name: 'Text AI', supportsTools: false },
    { id: 'text-two', name: 'Another text AI', supportsTools: false },
    { id: 'fallback', name: 'policy/text', fallbackPolicy: { modelIds: ['text', 'text-two'] } },
  ]);
  dialog(locale, 'fallback', false);
  expect(await screen.findByRole('link', { name: translate(locale, 'models.connectAi') })).toHaveAttribute('href', '/models?add=1');
  expect(screen.getByText(translate(locale, 'chat.quick.toolModelRequired'))).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: translate(locale, 'chat.quick.start') })).not.toBeInTheDocument();
});

it('retains a text-only model for saved-agent authoring', async () => {
  mockLoadModels.mockResolvedValue([{ id: 'text', name: 'Text AI', supportsTools: false }]);
  const view = dialog('en', 'text', true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start chat' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  await waitFor(() => expect(view.onStart).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'text' })));
});

describe.each(locales)('Quick Chat recovery in $locale', (messages) => {
  const text = {
    ...messages,
    start: translate(messages.locale, 'chat.quick.start'),
    retry: translate(messages.locale, 'common.tryAgain'),
    prompt: translate(messages.locale, 'chat.quick.systemPrompt'),
    noServers: translate(messages.locale, 'chat.quick.noServers'),
    noTools: translate(messages.locale, 'chat.quick.noTools'),
    customize: translate(messages.locale, 'chat.quick.customize', { server: 'Calendar' }),
  };
  it('offers recovery when the AI request reports failure without throwing', async () => {
    mockLoadModels.mockResolvedValue(null);
    dialog(text.locale, 'model-1');
    expect(await screen.findByRole('alert')).toHaveTextContent(text.loadFailed);
    expect(screen.getByRole('button', { name: text.start })).toBeDisabled();
    expect(screen.queryByText(translate(text.locale, 'chat.quick.noModels'))).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: translate(text.locale, 'models.connectAi') })).not.toBeInTheDocument();
    mockLoadModels.mockResolvedValue([{ id: 'model-1', name: 'Friendly AI', provider: 'openai' }]);
    fireEvent.click(screen.getByRole('button', { name: text.retry }));
    await waitFor(() => expect(screen.getByRole('button', { name: text.start })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('allows chatting after an app list successfully loads empty', async () => {
    mockLoadServers.mockResolvedValue([]);
    dialog(text.locale);
    expect(await screen.findByText(text.noServers)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: text.start })).toBeEnabled();
  });

  it.each(['returned', 'thrown'])('recovers a %s app-list failure without losing the prompt', async (failure) => {
    if (failure === 'returned') mockLoadServers.mockResolvedValue({ error: 'Offline' });
    else mockLoadServers.mockRejectedValue(new Error('Offline'));
    const view = dialog(text.locale, 'model-1');

    expect(await screen.findByRole('alert')).toHaveTextContent(text.loadFailed);
    expect(screen.getByRole('button', { name: text.start })).toBeDisabled();
    expect(screen.queryByText(text.noServers)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: translate(text.locale, 'models.connectAi') })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: text.prompt }), { target: { value: 'Help me plan my day.' } });

    mockLoadServers.mockResolvedValue([app]);
    fireEvent.click(screen.getByRole('button', { name: text.retry }));
    expect(await screen.findByRole('checkbox', { name: 'Calendar' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: text.start })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: text.prompt })).toHaveValue('Help me plan my day.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: text.start }));
    await waitFor(() => expect(view.onStart).toHaveBeenCalledWith({
      modelId: 'model-1', servers: [{ name: 'Calendar' }], systemPrompt: 'Help me plan my day.',
    }));
  });

  it.each(['returned', 'thrown'])('recovers a %s action-list failure without losing app selection or the prompt', async (failure) => {
    if (failure === 'returned') mockListTools.mockResolvedValue({ tools: [], error: 'Offline' });
    else mockListTools.mockRejectedValue(new Error('Offline'));
    const view = dialog(text.locale);
    const appCheckbox = await screen.findByRole('checkbox', { name: 'Calendar' });
    fireEvent.click(appCheckbox);
    fireEvent.change(screen.getByRole('textbox', { name: text.prompt }), { target: { value: 'Use my calendar.' } });
    fireEvent.click(screen.getByRole('button', { name: text.customize }));

    expect(await screen.findByRole('alert')).toHaveTextContent(text.toolsFailed);
    expect(screen.queryByText(text.noTools)).not.toBeInTheDocument();
    mockListTools.mockResolvedValue({ tools });
    fireEvent.click(screen.getByRole('button', { name: text.retry }));
    expect(await screen.findByRole('checkbox', { name: 'read_events' })).toBeChecked();
    expect(appCheckbox).toBeChecked();
    expect(screen.getByRole('textbox', { name: text.prompt })).toHaveValue('Use my calendar.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockListTools).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: text.start }));
    await waitFor(() => expect(view.onStart).toHaveBeenCalledWith({
      modelId: 'model-1', servers: [{ name: 'Calendar' }], systemPrompt: 'Use my calendar.',
    }));
  });

  it('keeps a genuinely empty action list distinct from a failed request', async () => {
    mockListTools.mockResolvedValue({ tools: [] });
    dialog(text.locale);
    await screen.findByRole('checkbox', { name: 'Calendar' });
    fireEvent.click(screen.getByRole('button', { name: text.customize }));
    expect(await screen.findByText(text.noTools)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: text.retry })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: text.start })).toBeEnabled();
  });
});

it.each([
  ['en', 'Connect an AI to start', 'Connect AI'],
  ['es', 'Conecta una IA para empezar', 'Conectar IA'],
  ['de', 'Verbinde eine KI, um zu starten', 'KI verbinden'],
  ['fr', 'Connectez une IA pour commencer', 'Connecter l’IA'],
  ['it', 'Collega una IA per iniziare', 'Collega IA'],
  ['pt', 'Conecte uma IA para começar', 'Conectar IA'],
  ['zh-CN', '连接 AI 即可开始', '连接 AI'],
] as const)('guides a first-time user to connect AI in %s', async (locale, guidance, connectLabel) => {
  mockLoadModels.mockResolvedValue([]);
  const view = dialog(locale);

  expect(await screen.findByText(guidance)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: connectLabel })).toHaveAttribute('href', '/models?add=1');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: translate(locale, 'chat.quick.start') })).not.toBeInTheDocument();
  expect(screen.queryByText(translate(locale, 'chat.quick.help'))).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: translate(locale, 'common.tryAgain') })).not.toBeInTheDocument();
  expect(view.onStart).not.toHaveBeenCalled();
});

it('waits for setup before offering to connect AI', async () => {
  let resolveModels!: (models: unknown[]) => void;
  mockLoadModels.mockImplementationOnce(() => new Promise(resolve => { resolveModels = resolve; }));
  dialog('en');

  expect(screen.getByRole('progressbar')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Connect AI' })).not.toBeInTheDocument();
  expect(screen.queryByText('Connect an AI to start')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start chat' })).toBeDisabled();

  await act(async () => resolveModels([]));
  expect(await screen.findByRole('link', { name: 'Connect AI' })).toHaveAttribute('href', '/models?add=1');
});

it('starts with a configured AI and the chosen instructions and app', async () => {
  const view = dialog('en');
  const appCheckbox = await screen.findByRole('checkbox', { name: 'Calendar' });
  expect(screen.queryByRole('link', { name: 'Connect AI' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveTextContent('Friendly AI');
  fireEvent.change(screen.getByRole('textbox', { name: translate('en', 'chat.quick.systemPrompt') }), {
    target: { value: 'Help me plan tomorrow.' },
  });
  fireEvent.click(appCheckbox);
  fireEvent.click(screen.getByRole('button', { name: translate('en', 'chat.quick.start') }));
  await waitFor(() => expect(view.onStart).toHaveBeenCalledWith({
    modelId: 'model-1', servers: [{ name: 'Calendar' }], systemPrompt: 'Help me plan tomorrow.',
  }));
});

it('ignores a slow action response from an earlier opening', async () => {
  let resolveOldTools!: (result: { tools: typeof tools }) => void;
  mockListTools.mockImplementationOnce(() => new Promise((resolve) => { resolveOldTools = resolve; }));
  const view = dialog('en');
  await screen.findByRole('checkbox', { name: 'Calendar' });
  fireEvent.click(screen.getByRole('button', { name: translate('en', 'chat.quick.customize', { server: 'Calendar' }) }));
  view.setOpen(false);
  view.setOpen(true);
  await screen.findByRole('checkbox', { name: 'Calendar' });
  fireEvent.click(screen.getByRole('button', { name: translate('en', 'chat.quick.customize', { server: 'Calendar' }) }));
  expect(await screen.findByRole('checkbox', { name: 'read_events' })).toBeInTheDocument();
  const oldTools = [{ name: 'old_action', description: 'Old action', inputSchema: { type: 'object' } }];
  await act(async () => resolveOldTools({ tools: oldTools }));
  expect(screen.getByRole('checkbox', { name: 'read_events' })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'old_action' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Calendar' })).not.toBeChecked();
});
