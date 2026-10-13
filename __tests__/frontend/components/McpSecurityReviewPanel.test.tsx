import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import McpSecurityReviewPanel from '@/frontend/components/mcp/McpSecurityReviewPanel';
import MarketplaceTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/MarketplaceTab';
import GitHubTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/GitHubTab';
import { __resetWorkspaceSelectionForTests, setSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import type { McpSecurityReview } from '@/shared/mcpSecurityReview';

const repositoryUrl = 'https://github.com/example/tools';
const report: McpSecurityReview = {
  status: 'partial', message: 'Do not render a backend configuration path',
  source: { repositoryUrl, revision: 'a'.repeat(40), digest: 'b'.repeat(64), fileCount: 2, bytes: 420 },
  scanner: { name: 'SkillSpector', version: '2.12.0', imageId: `sha256:${'c'.repeat(64)}`, mode: 'static', dependencyLookup: 'offline' },
  risk: { severity: 'HIGH', score: 70 },
  findings: [{ severity: 'HIGH', category: 'instructions', file: 'README.md', line: 4, message: '<img src=x onerror=alert(1)> [Click](javascript:alert(1))' }],
  limitations: ['No skill manifest was found.'],
};
const response = (review = report) => ({ ok: true, json: async () => ({ success: true, review }) });
function deferred() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const promise = new Promise<ReturnType<typeof response>>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Optional MCP repository review', () => {
  beforeEach(() => {
    __resetWorkspaceSelectionForTests();
    window.localStorage.clear();
    global.fetch = jest.fn().mockResolvedValue(response());
  });
  afterEach(() => { jest.restoreAllMocks(); __resetWorkspaceSelectionForTests(); });

  it('suspends pending review on tab hide and rejects late evidence without restarting', async () => {
    const pending = deferred(); (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal;
    rerender(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} active={false} />);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Review repository' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review repository', hidden: true }));
    await act(async () => pending.resolve(response()));
    rerender(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    expect(screen.getByText('Review cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves completed scanner evidence across tab suspension', async () => {
    const { rerender } = render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('No skill manifest was found.');
    rerender(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} active={false} />);
    expect(screen.getByText('No skill manifest was found.')).not.toBeVisible();
    rerender(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    expect(screen.getByText('No skill manifest was found.')).toBeVisible();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('runs only on explicit request, binds the workspace, and renders evidence as text', async () => {
    window.localStorage.setItem('flujo-ui:workspace', 'research');
    const { rerender, container } = render(<McpSecurityReviewPanel repositoryUrl="" />);
    expect(screen.getByRole('button', { name: 'Review repository' })).toBeDisabled();
    rerender(<McpSecurityReviewPanel repositoryUrl="https://github.com/Example/Tools.git/" />);
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('No skill manifest was found.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/mcp/security-review?workspace=research', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ repositoryUrl }), signal: expect.any(AbortSignal),
    }));
    expect(screen.getByText(report.findings![0].message)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Click' })).not.toBeInTheDocument();
    expect(screen.getByText(`Pinned revision: ${'a'.repeat(40)}`)).toBeInTheDocument();
    expect(screen.getByText('Source coverage: 2 files · 420 bytes')).toBeInTheDocument();
    expect(screen.getByText(/static analysis · offline dependency lookup/)).toBeInTheDocument();
    expect(screen.queryByText(report.message)).not.toBeInTheDocument();
    expect(screen.getByText(/does not certify a downloaded Registry package/)).toBeInTheDocument();
  });

  it.each([
    'http://github.com/example/tools', 'https://github.com/example/tools/tree/main',
    'https://github.com/example/tools?ref=main', 'https://github.com/example/tools#readme',
    'https://github.com.evil.test/example/tools', 'https://user:secret@github.com/example/tools',
    'https://gitlab.com/example/tools',
    'https://github.com/example/placeholder/../../example/tools',
    'https://github.com/example/%74ools', 'https://github.com:443/example/tools',
  ])('does not submit unsupported target %s', target => {
    render(<McpSecurityReviewPanel repositoryUrl={target} />);
    expect(screen.getByRole('button', { name: 'Review repository' })).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('accepts exact repository names with a leading dot without requesting automatically', () => {
    render(<McpSecurityReviewPanel repositoryUrl="https://github.com/example/.github" />);
    expect(screen.getByRole('button', { name: 'Review repository' })).toBeEnabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('aborts target changes and rejects a late previous result even after switching back', async () => {
    const old = deferred();
    (global.fetch as jest.Mock).mockReturnValueOnce(old.promise);
    const { rerender } = render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal;
    rerender(<McpSecurityReviewPanel repositoryUrl="https://github.com/example/other" />);
    expect(signal.aborted).toBe(true);
    rerender(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    await act(async () => { old.resolve(response()); await old.promise; });
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('No skill manifest was found.');
  });

  it('cancels explicitly and ignores a response whose fetch mock ignores abort', async () => {
    const pending = deferred();
    (global.fetch as jest.Mock).mockReturnValue(pending.promise);
    render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response()); await pending.promise; });
    expect(screen.getByText('Review cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
  });

  it('drops completed evidence and aborts pending work on workspace change', async () => {
    render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('No skill manifest was found.');
    act(() => setSelectedWorkspace('other-workspace'));
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
    const pending = deferred();
    (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('workspace=other-workspace');
    act(() => setSelectedWorkspace('third-workspace'));
    expect((global.fetch as jest.Mock).mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response()); await pending.promise; });
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts when the containing view unmounts', async () => {
    const pending = deferred();
    (global.fetch as jest.Mock).mockReturnValue(pending.promise);
    const { unmount } = render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    unmount();
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response()); await pending.promise; });
  });

  it('keeps unavailable failures generic and provides operator setup help', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('SECRET C:\\operator\\scanner.json'));
    render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    expect(await screen.findByRole('link', { name: 'Scanner setup help' })).toHaveAttribute('href', '/docs');
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  });

  it('rejects a report bound to a different source repository', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response({ ...report, source: { ...report.source!, repositoryUrl: 'https://github.com/example/different' } }));
    render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByRole('link', { name: 'Scanner setup help' });
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
  });

  it('never turns the vendor’s lowest risk category into a safety verdict', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response({ ...report, status: 'reviewed', risk: { score: 0, severity: 'SAFE' }, findings: [] }));
    render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('Scanner-reported risk: Lowest scanner risk band (0)');
    expect(screen.getByText('No findings reported within this review’s coverage.')).toBeInTheDocument();
    expect(screen.queryByText(/SAFE/)).not.toBeInTheDocument();
  });

  it('does not present completed analysis without source and scanner evidence', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response({ status: 'reviewed', message: '', limitations: [], findings: [] }));
    render(<McpSecurityReviewPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByRole('link', { name: 'Scanner setup help' });
    expect(screen.queryByText('No findings reported within this review’s coverage.')).not.toBeInTheDocument();
  });

  it('keeps GitHub review explicit during mount and typing without cloning or handoff', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => url.includes('security-review')
      ? response() : { ok: true, json: async () => ({ success: true, mcpServersDir: 'mcp-servers' }) });
    const onAdd = jest.fn();
    const onHandoff = jest.fn();
    render(<GitHubTab onAdd={onAdd} onHandoff={onHandoff} onClose={jest.fn()} />);
    const reviewCalls = () => (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes('security-review'));
    expect(reviewCalls()).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: repositoryUrl } });
    expect(reviewCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('No skill manifest was found.');
    expect(reviewCalls()).toHaveLength(1);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://github.com/example/other' } });
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(1);
  });

  it('leaves Marketplace consent unchanged and cancels when its details dialog closes', async () => {
    const pending = deferred();
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, servers: [{
      server: { name: 'example/tools', title: 'Review fixture', repository: { url: repositoryUrl }, packages: [{ registryType: 'npm', identifier: '@example/tools' }] },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    }], metadata: {} }) }).mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    const onAdd = jest.fn();
    const onHandoff = jest.fn();
    render(<MarketplaceTab onAdd={onAdd} onHandoff={onHandoff} onClose={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByText('Review fixture'));
    const consent = screen.getByRole('checkbox');
    const installOption = screen.getByRole('button', { name: /@example\/tools/ });
    expect(consent).not.toBeChecked();
    expect(installOption).toHaveAttribute('aria-disabled', 'true');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    await screen.findByText('No skill manifest was found.');
    expect(consent).not.toBeChecked();
    expect(installOption).toHaveAttribute('aria-disabled', 'true');
    expect(onAdd).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
    fireEvent.click(consent);
    expect(consent).toBeChecked();
    expect(installOption).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Review repository' }));
    expect(installOption).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls[2][1].signal.aborted).toBe(true));
    await act(async () => { pending.resolve(response()); await pending.promise; });
    expect(screen.queryByText('No skill manifest was found.')).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
  });
});
