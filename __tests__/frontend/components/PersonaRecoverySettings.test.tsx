/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PersonaRecoverySettings from '@/frontend/components/Settings/PersonaRecoverySettings';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { formatDate, translate } from '@/frontend/i18n/core';
import { LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from '@/frontend/i18n/locales';

let selected = 'source-workspace';
let workspaceChanged: (workspace: string) => void;
jest.mock('@/frontend/utils/workspaceSelection', () => ({
  ...jest.requireActual('@/frontend/utils/workspaceSelection'),
  getSelectedWorkspace: () => selected,
  onWorkspaceChanged: (listener: typeof workspaceChanged) => { workspaceChanged = listener; return jest.fn(); },
  workspacePageUrl: (workspace: string) => `/settings?workspace=${workspace}`,
}));
const fetchMock = jest.fn();
const originalFetch = global.fetch;
const response = (value: unknown) => ({ ok: true, json: async () => value });
const preview = {
  sourceWorkspace: 'source-workspace', destinationWorkspace: 'restored-workspace', capturedAt: 1,
  sourceCounts: { personas: 1, 'persona-memories': 2, flows: 3 }, requiredModelIds: ['model-a'], requiredAppNames: ['App A'], previewToken: 'reviewed-token',
};

function chooseFile(size = 4) {
  const file = new File([new Uint8Array(size)], 'persona-backup.zip', { type: 'application/zip' });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
  fireEvent.change(screen.getByRole('textbox', { name: 'New workspace name' }), { target: { value: 'restored-workspace' } });
  return file;
}

describe('Persona recovery owner review', () => {
  beforeEach(() => {
    jest.clearAllMocks(); selected = 'source-workspace'; global.fetch = fetchMock;
    window.localStorage.clear();
    URL.createObjectURL = jest.fn(() => 'blob:recovery'); URL.revokeObjectURL = jest.fn();
  });
  afterAll(() => { global.fetch = originalFetch; });

  it('opens file selection from a native keyboard-accessible button', () => {
    render(<PersonaRecoverySettings />);
    const button = screen.getByRole('button', { name: 'Choose Persona recovery file' });
    expect(button.tagName).toBe('BUTTON');
    const click = jest.spyOn(document.querySelector('input[type="file"]') as HTMLInputElement, 'click').mockImplementation(() => undefined);
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('explains private data and frozen work, then restores only the previewed archive after confirmation', async () => {
    fetchMock.mockResolvedValueOnce(response(preview));
    let finish!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<PersonaRecoverySettings />);
    expect(screen.getByText(/contains private data and is not encrypted/)).toBeInTheDocument();
    const file = chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preview recovery' });
    expect(within(dialog).getByText(/Nothing resumes automatically/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore into new workspace' }));
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: file, headers: { 'x-persona-recovery-preview': 'reviewed-token', 'x-persona-recovery-action': 'restore' } });
    await act(async () => finish(response({ workspace: 'restored-workspace' })));
    expect(await screen.findByRole('link', { name: 'Open restored workspace' })).toHaveAttribute('href', '/settings?workspace=restored-workspace');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open restored workspace' })).toHaveFocus());
  });

  it('allows cancelling preview without publishing and rejects an empty file before upload', async () => {
    fetchMock.mockResolvedValueOnce(response(preview));
    render(<PersonaRecoverySettings />); chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Preview recovery' })).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    chooseFile(0); fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    expect(await screen.findByText(/Choose a non-empty Persona recovery ZIP/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards a late preview when the selected workspace changes', async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<PersonaRecoverySettings />); chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    act(() => { selected = 'other-workspace'; workspaceChanged(selected); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => finish(response(preview)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New workspace name' })).toHaveValue('');
    expect(screen.queryByText('persona-backup.zip')).not.toBeInTheDocument();
  });

  it('shows a backup summary before creating a download', async () => {
    const blob = new Blob(['zip']);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => blob, headers: { get: () => encodeURIComponent(JSON.stringify({
      sourceWorkspace: selected, captureId: 'capture-id', capturedAt: 1, archiveBytes: blob.size, counts: { personas: 1 },
    })) } });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<PersonaRecoverySettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare Persona backup' }));
    const dialog = await screen.findByRole('dialog');
    expect(click).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download recovery backup' }));
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob); expect(click).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare Persona backup' })).toHaveFocus());
    click.mockRestore();
  });

  it('does not move focus back to a trigger after switching workspaces with a dialog open', async () => {
    fetchMock.mockResolvedValueOnce(response(preview));
    render(<PersonaRecoverySettings />); chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    await screen.findByRole('dialog');
    act(() => { selected = 'other-workspace'; workspaceChanged(selected); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Prepare Persona backup' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Preview recovery' })).not.toHaveFocus();
  });

  it.each(SUPPORTED_LOCALES)('retains upload choices and offers a localized retry after a rejected ZIP in $code', async ({ code }) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, code);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Invalid recovery ZIP end directory.' }) });
    render(<I18nProvider><PersonaRecoverySettings /></I18nProvider>);
    const file = new File(['broken zip'], 'persona-backup.zip', { type: 'application/zip' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    const destination = screen.getByRole('textbox', { name: translate(code, 'settings.personaRecovery.destination') });
    fireEvent.change(destination, { target: { value: 'restored-workspace' } });
    fireEvent.click(screen.getByRole('button', { name: translate(code, 'settings.personaRecovery.inspect') }));
    const error = await screen.findByText(translate(code, 'settings.personaRecovery.inspectFailed'));
    expect(error.closest('[role="alert"]')).toHaveFocus();
    expect(screen.queryByText('Invalid recovery ZIP end directory.')).not.toBeInTheDocument();
    expect(destination).toHaveValue('restored-workspace');
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).files?.[0]).toBe(file);
    expect(screen.getByRole('button', { name: translate(code, 'settings.personaRecovery.inspect') })).toBeEnabled();
    fetchMock.mockResolvedValueOnce(response(preview));
    fireEvent.click(screen.getByRole('button', { name: translate(code, 'settings.personaRecovery.inspect') }));
    await screen.findByRole('dialog');
    expect(fetchMock.mock.calls[1][1].body).toBe(file);
  });

  it.each(SUPPORTED_LOCALES)('localizes a network failure while preparing a backup in $code', async ({ code }) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, code);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<I18nProvider><PersonaRecoverySettings /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: translate(code, 'settings.personaRecovery.prepare') }));
    expect((await screen.findByText(translate(code, 'settings.personaRecovery.captureFailed'))).closest('[role="alert"]')).toHaveFocus();
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: translate(code, 'settings.personaRecovery.prepare') })).toBeEnabled();
  });

  it.each([
    [423, 'settings.personaRecovery.locked'],
    [403, 'settings.personaRecovery.localOnly'],
    [413, 'settings.personaRecovery.fileLimit'],
  ] as const)('gives actionable localized guidance for HTTP %s', async (status, key) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: 'Raw backend diagnostic' }) });
    render(<PersonaRecoverySettings />); chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    expect((await screen.findByText(translate('en', key))).closest('[role="alert"]')).toHaveFocus();
    expect(screen.queryByText('Raw backend diagnostic')).not.toBeInTheDocument();
  });

  it('keeps a failed restore in the preview with one focused error and permits reviewing the same file again', async () => {
    fetchMock.mockResolvedValueOnce(response(preview));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<PersonaRecoverySettings />); chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Preview recovery' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore into new workspace' }));
    const errors = await screen.findAllByText(translate('en', 'settings.personaRecovery.restoreFailed'));
    expect(errors).toHaveLength(1);
    expect(errors[0].closest('[role="alert"]')).toHaveFocus();
    expect(dialog).toContainElement(errors[0]);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Preview recovery' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'New workspace name' })).toHaveValue('restored-workspace');
  });

  it.each([
    ['The recovery destination already exists; choose a new workspace name.', 'settings.personaRecovery.destinationExists'],
    ['A case-equivalent recovery workspace already exists.', 'settings.personaRecovery.destinationExists'],
    ['The destination contains a different recovery or existing workspace.', 'settings.personaRecovery.destinationExists'],
    ['Recovery preview changed; inspect the archive and destination again.', 'settings.personaRecovery.previewChanged'],
  ] as const)('keeps specific restore guidance localized for %s', async (backendMessage, key) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    fetchMock.mockResolvedValueOnce(response(preview));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: backendMessage }) });
    render(<I18nProvider><PersonaRecoverySettings /></I18nProvider>);
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['zip'], 'persona-backup.zip')] } });
    fireEvent.change(screen.getByRole('textbox', { name: translate('es', 'settings.personaRecovery.destination') }), { target: { value: 'restored-workspace' } });
    fireEvent.click(screen.getByRole('button', { name: translate('es', 'settings.personaRecovery.inspect') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: translate('es', 'settings.personaRecovery.restore') }));
    expect((await within(dialog).findByText(translate('es', key))).closest('[role="alert"]')).toHaveFocus();
    expect(screen.queryByText(backendMessage)).not.toBeInTheDocument();
  });

  it.each(SUPPORTED_LOCALES)('uses the selected $code locale for the capture date', async ({ code }) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, code);
    const blob = new Blob(['zip']);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => blob, headers: { get: () => encodeURIComponent(JSON.stringify({
      sourceWorkspace: selected, captureId: 'capture-id', capturedAt: 1, archiveBytes: blob.size, counts: { personas: 1 },
    })) } });
    render(<I18nProvider><PersonaRecoverySettings /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: translate(code, 'settings.personaRecovery.prepare') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(translate(code, 'settings.personaRecovery.source', { workspace: selected, date: formatDate(code, 1, { dateStyle: 'medium', timeStyle: 'medium' }) }))).toBeInTheDocument();
  });
});
