import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConnectionSetup from '@/frontend/components/AvatarWorld/ConnectionSetup';
import type { AvatarConnectionCandidate } from '@/shared/types/avatar';
const saved: AvatarConnectionCandidate = { id: 'saved:model', kind: 'saved-model', modelId: 'model', label: 'My work model', host: 'flujo-server', runtime: 'available', authentication: 'configured', verification: 'untested', nextAction: 'use-and-test', modelChoices: [{ id: 'sonnet', label: 'sonnet', source: 'saved' }] };
describe('avatar setup connects through Flujo', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ candidates: [saved] }) }));
    global.fetch = fetchMock;
  });
  it('does not test providers during discovery and leaves a failed test editable', async () => {
    const verified = jest.fn(async () => {}), close = jest.fn();
    render(<ConnectionSetup locale="es" onClose={close} onVerified={verified} onOther={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /My work model/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ready: false, test: { ok: false, diagnosis: 'No tool roundtrip' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar y comprobar' }));
    await screen.findByRole('alert');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/avatar/work-model');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ modelId: 'model' });
    expect(verified).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Conectar y comprobar' })).toBeEnabled();
  });
  it('waits for the verified backend preference before entering the world', async () => {
    const verified = jest.fn(async () => {}), close = jest.fn();
    render(<ConnectionSetup locale="pt" onClose={close} onVerified={verified} onOther={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /My work model/ }));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, test: { ok: true } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar e verificar' }));
    await waitFor(() => expect(verified).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('uses a password field for Claude tokens and keeps them out of the visible guidance', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ ...saved, id: 'claude-subscription', kind: 'claude-subscription', modelId: undefined, label: 'Claude', authentication: 'needs-connection', nextAction: 'connect-token', modelChoices: [{ id: 'sonnet', label: 'sonnet', source: 'fallback' }] }] }) });
    render(<ConnectionSetup locale="es" onClose={jest.fn()} onVerified={jest.fn()} onOther={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Claude/ }));
    const token = screen.getByLabelText('Token de Claude');
    expect(token).toHaveAttribute('type', 'password');
    fireEvent.change(token, { target: { value: 'PRIVATE_OAUTH_TOKEN' } });
    expect(document.body.textContent).not.toContain('PRIVATE_OAUTH_TOKEN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('never preselects an unverified subscription model hint', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ ...saved, id: 'codex-subscription', kind: 'codex-subscription', modelId: undefined, label: 'Codex', authentication: 'login-detected', modelChoices: [{ id: 'unverified-hint', label: 'unverified-hint', source: 'host-cache', updatedAt: Date.now() }] }] }) });
    render(<ConnectionSetup locale="en" onClose={jest.fn()} onVerified={jest.fn()} onOther={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
    expect(screen.getByLabelText('Model for thinking and working')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Connect and verify' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Model for thinking and working'), { target: { value: 'my-model' } });
    expect(screen.getByRole('button', { name: 'Connect and verify' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
