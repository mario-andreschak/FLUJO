/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PersonaRecoverySettings from '@/frontend/components/Settings/PersonaRecoverySettings';

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
});
