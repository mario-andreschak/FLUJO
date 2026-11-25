import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DiagnosticReportPanel from '@/frontend/components/Settings/DiagnosticReportPanel';

const report = {
  version: 1,
  createdAt: '2026-11-25T10:00:00.000Z',
  app: { version: '3.48.10', installMode: 'npm' },
  system: { os: 'linux', arch: 'x64', nodeVersion: '22.23.4', cpuCores: 4, memoryGb: 16 },
  security: { networkAccess: 'localhost', ownerLogin: false, credentialProtection: 'passphrase' },
  aiConnections: { total: 1, byProvider: { ollama: 1, 'Private model': 2 } },
  apps: null,
  agents: { total: 2, usingApps: 1, steps: 5 },
  automations: { total: 0, enabled: 0, byTrigger: {}, lastRunFailed: 0 },
  activity: null,
  unavailable: ['apps', 'activity'],
  leaked: 'sk-SECRET',
};

describe('DiagnosticReportPanel', () => {
  const originalFetch = global.fetch;
  const originalClipboard = navigator.clipboard;
  let writeText: jest.Mock;

  beforeEach(() => {
    writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    jest.clearAllMocks();
  });

  it('creates nothing and contacts nothing until the person asks', () => {
    global.fetch = jest.fn();

    render(<DiagnosticReportPanel />);

    expect(screen.getByRole('heading', { name: 'Diagnostic report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create report' })).toBeEnabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the report from this computer and copies only that text', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => report });

    render(<DiagnosticReportPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Create report' }));

    const preview = await screen.findByLabelText('Report (read it before you share it)');
    const text = (preview as HTMLTextAreaElement).value;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/diagnostics/report', expect.objectContaining({ cache: 'no-store' }));
    expect(text).toContain('FLUJO: 3.48.10 (npm)');
    expect(text).toContain('AI connections: 1 (ollama 1, other 2)');
    expect(text).toContain('Could not read: connected apps, activity');
    expect(text).not.toMatch(/SECRET|Private model/);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(text);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('explains what to do when the report cannot be created', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 423 });

    render(<DiagnosticReportPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Create report' }));

    expect(await screen.findByText(/If FLUJO asks for your encryption password/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create report' })).toBeEnabled();
  });

  it('tells the person to copy by hand when the browser blocks copying', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => report });
    writeText.mockRejectedValue(new Error('denied'));

    render(<DiagnosticReportPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Create report' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    expect(await screen.findByText(/Select the text and copy it yourself/)).toBeInTheDocument();
  });
});
