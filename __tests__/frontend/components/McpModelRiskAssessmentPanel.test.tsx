import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import McpModelRiskAssessmentPanel from '@/frontend/components/mcp/McpModelRiskAssessmentPanel';
import MarketplaceTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/MarketplaceTab';
import GitHubTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/GitHubTab';
import { __resetWorkspaceSelectionForTests, setSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import type { McpModelRiskAssessment } from '@/shared/mcpModelRiskAssessment';
import { mcpMessageRows } from '@/frontend/i18n/catalogs/mcp';

const repositoryUrl = 'https://github.com/example/tools';
const models = [
  { id: 'text-a', name: 'Text A', provider: 'openai', adapter: 'openai', ApiKey: 'masked' },
  { id: 'text-b', name: 'Text B', provider: 'anthropic', adapter: 'anthropic', ApiKey: 'masked' },
  { id: 'cli', name: 'Forbidden CLI', adapter: 'codex-cli' },
  { id: 'agent', name: 'Forbidden Agent', adapter: 'claude-subscription' },
  { id: 'media', name: 'Forbidden Media', adapter: 'openai', outputModalities: ['text', 'image'] },
  { id: 'fallback', name: 'Forbidden Fallback', adapter: 'openai', fallbackPolicy: {} },
];
const malicious = '<img src=x onerror=alert(1)> [Install now](javascript:alert(1))';
const sampleReview: McpModelRiskAssessment = {
  status: 'assessed', model: { id: 'text-b', name: 'Text B' }, assessment: { score: 0, rationale: malicious, flags: ['Popularity does not prove safety.'] },
  source: {
    repositoryUrl, revision: 'a'.repeat(40), capturedAt: '2026-10-09T20:00:00.000Z', evidenceDigest: 'b'.repeat(64),
    repository: { stars: 12, forks: 3, lastCommitAt: '2026-10-08T00:00:00Z', openIssues: 2, closedIssues: 8, openIssueRatio: 0.2 },
    author: { login: 'example', type: 'User', followers: 4, publicRepositories: 6, createdAt: '2020-01-01T00:00:00Z', accountAgeDays: 2000 },
    limitations: ['sampleOnly', 'sourceTruncated'], fileCount: 2, bytes: 500,
  },
};
const review: McpModelRiskAssessment = {
  ...sampleReview, source: { ...sampleReview.source!, limitations: ['signalsOnly'], fileCount: 0, bytes: 0 },
};
const jsonResponse = (value: unknown) => ({ ok: true, json: async () => value });
const assessmentResponse = (value: unknown = review) => jsonResponse({ success: true, review: value });
function deferred() {
  let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
  const promise = new Promise<ReturnType<typeof jsonResponse>>(done => { resolve = done; });
  return { promise, resolve };
}
async function openAndChoose(modelId = 'text-b') {
  fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
  await screen.findByRole('option', { name: 'Text B' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Assessment model' }), { target: { value: modelId } });
}
function submit() { fireEvent.click(screen.getByRole('button', { name: 'Send evidence and assess' })); }

describe('Optional configured-model MCP risk assessment', () => {
  beforeEach(() => {
    __resetWorkspaceSelectionForTests();
    window.localStorage.clear();
    global.fetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => String(url).includes('/api/model?') ? jsonResponse(models)
      : assessmentResponse(options?.body && JSON.parse(String(options.body)).includeSource ? sampleReview : review));
  });
  afterEach(() => { jest.restoreAllMocks(); __resetWorkspaceSelectionForTests(); });

  it('makes no calls while browsing or typing; requires an explicit model and final send', async () => {
    window.localStorage.setItem('flujo-ui:workspace', 'research');
    const { rerender, container } = render(<McpModelRiskAssessmentPanel repositoryUrl="" />);
    expect(screen.getByRole('button', { name: 'AI risk assessment' })).toBeDisabled();
    rerender(<McpModelRiskAssessmentPanel repositoryUrl="https://github.com/Example/Tools.git/" />);
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
    await screen.findByRole('option', { name: 'Text A' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/model?workspace=research', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('combobox', { name: 'Assessment model' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Include sampled README and source excerpts' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Send evidence and assess' })).toBeDisabled();
    expect(screen.getByText(/Provider fees may apply/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Forbidden/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Assessment model' }), { target: { value: 'text-b' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include sampled README and source excerpts' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    submit();
    await screen.findByText(malicious);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith('/api/mcp/model-risk-assessment?workspace=research', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ repositoryUrl, modelId: 'text-b', includeSource: true }), signal: expect.any(AbortSignal),
    }));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Install now' })).not.toBeInTheDocument();
    expect(screen.getByText('Model-reported risk: 0/100 (higher means more risk)')).toBeInTheDocument();
    expect(screen.getByText(`Pinned revision: ${'a'.repeat(40)}`)).toBeInTheDocument();
    expect(screen.getByText(/Issues open: 2 · Closed: 8 · Open ratio: 20%/)).toBeInTheDocument();
    expect(screen.getByText('Excerpts sent: 2 files · 500 bytes')).toBeInTheDocument();
    expect(screen.getByText(/Some source excerpts were truncated/)).toBeInTheDocument();
    expect(screen.getByText(/Existing trust and execution consent still apply/)).toBeInTheDocument();
  });

  it('does not opt into source transmission by default', async () => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose(); submit();
    await screen.findByText(malicious);
    expect((global.fetch as jest.Mock).mock.calls[1][1].body).toBe(JSON.stringify({ repositoryUrl, modelId: 'text-b', includeSource: false }));
  });

  it.each(['http://github.com/example/tools', 'https://github.com/example/tools/tree/main', 'https://github.com/example/tools?ref=main',
    'https://github.com/example/tools#readme', 'https://github.com.evil.test/example/tools', 'https://user:secret@github.com/example/tools',
    'https://github.com:443/example/tools', 'https://github.com/example/%74ools', 'https://github.com/example/x/../../example/tools'])('refuses unsupported target %s', url => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={url} />);
    expect(screen.getByRole('button', { name: 'AI risk assessment' })).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['model', 'source'] as const)('aborts and discards a result after changing %s selection', async selection => {
    const pending = deferred();
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose();
    (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    submit();
    const signal = (global.fetch as jest.Mock).mock.calls[1][1].signal;
    if (selection === 'model') fireEvent.change(screen.getByRole('combobox'), { target: { value: 'text-a' } });
    else fireEvent.click(screen.getByRole('checkbox'));
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(assessmentResponse()); await pending.promise; });
    expect(screen.queryByText(malicious)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('clears completed evidence on selection changes', async () => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose(); submit(); await screen.findByText(malicious);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'text-a' } });
    expect(screen.queryByText(malicious)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['url', 'workspace', 'cancel', 'hide', 'unmount'] as const)('discards pending assessment after %s', async change => {
    const pending = deferred();
    const view = render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose();
    (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    submit();
    const signal = (global.fetch as jest.Mock).mock.calls[1][1].signal;
    if (change === 'url') {
      view.rerender(<McpModelRiskAssessmentPanel repositoryUrl="https://github.com/example/other" />);
      view.rerender(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    } else if (change === 'workspace') act(() => setSelectedWorkspace('other-workspace'));
    else if (change === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel assessment' }));
    else if (change === 'hide') fireEvent.click(screen.getByRole('button', { name: 'Hide assessment' }));
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(assessmentResponse()); await pending.promise; });
    expect(screen.queryByText(malicious)).not.toBeInTheDocument();
    if (change === 'cancel') expect(screen.getByText('Assessment cancelled.')).toBeInTheDocument();
  });

  it.each(['url', 'workspace', 'hide', 'unmount'] as const)('fences a late saved-model list after %s', async change => {
    const pending = deferred();
    (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    const view = render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
    const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal;
    if (change === 'url') view.rerender(<McpModelRiskAssessmentPanel repositoryUrl="https://github.com/example/other" />);
    else if (change === 'workspace') act(() => setSelectedWorkspace('other'));
    else if (change === 'hide') fireEvent.click(screen.getByRole('button', { name: 'Hide assessment' }));
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(jsonResponse(models)); await pending.promise; });
    expect(screen.queryByRole('option', { name: 'Text A' })).not.toBeInTheDocument();
  });

  it('does not keep the previous workspace’s model selection when reopened', async () => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose();
    act(() => setSelectedWorkspace('other'));
    fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
    await screen.findByRole('option', { name: 'Text B' });
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe('/api/model?workspace=other');
  });

  it.each([
    { label: 'wrong source', value: { ...review, source: { ...review.source!, repositoryUrl: 'https://github.com/example/other' } } },
    { label: 'wrong model', value: { ...review, model: { id: 'text-a', name: 'Text A' } } },
    { label: 'missing source', value: { ...review, source: undefined } },
    { label: 'bad score', value: { ...review, assessment: { ...review.assessment!, score: 101 } } },
    { label: 'fractional score', value: { ...review, assessment: { ...review.assessment!, score: 1.5 } } },
    { label: 'overlong rationale', value: { ...review, assessment: { ...review.assessment!, rationale: 'x'.repeat(2049) } } },
    { label: 'blank rationale', value: { ...review, assessment: { ...review.assessment!, rationale: '   ' } } },
    { label: 'control character', value: { ...review, assessment: { ...review.assessment!, rationale: 'hidden\u0000text' } } },
    { label: 'too many flags', value: { ...review, assessment: { ...review.assessment!, flags: Array(13).fill('flag') } } },
    { label: 'overlong flag', value: { ...review, assessment: { ...review.assessment!, flags: ['x'.repeat(257)] } } },
    { label: 'missing signals', value: { ...review, source: { ...review.source!, repository: {} } } },
    { label: 'bad digest', value: { ...review, source: { ...review.source!, evidenceDigest: 'not-a-digest' } } },
    { label: 'private source excerpts in receipt', value: { ...review, source: { ...review.source!, files: [{ text: 'hidden excerpt' }] } } },
    { label: 'source sent despite opt-out', value: sampleReview },
    { label: 'missing opt-out limitation', value: { ...review, source: { ...review.source!, limitations: [] } } },
    { label: 'verdict on unavailable status', value: { ...review, status: 'unavailable' } },
    { label: 'unexpected tool calls', value: { ...review, tool_calls: [{ function: { name: 'install' } }] } },
    { label: 'unexpected approval', value: { ...review, assessment: { ...review.assessment!, safe_to_install: true } } },
  ])('rejects $label without presenting a model verdict', async ({ value }) => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose();
    (global.fetch as jest.Mock).mockResolvedValueOnce(assessmentResponse(value));
    submit(); await screen.findByText('Assessment unavailable. Check the selected connection or try again later.');
    expect(screen.queryByText(malicious)).not.toBeInTheDocument();
  });

  it('offers an explicit retry for lazy model-load failures without exposing errors', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('SECRET /owner/credentials'));
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
    await screen.findByText(/Saved models could not be loaded/);
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await openAndChoose();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts the advisory schema boundaries without converting maximum risk into approval', async () => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose();
    (global.fetch as jest.Mock).mockResolvedValueOnce(assessmentResponse({
      ...review, assessment: { score: 100, rationale: 'x'.repeat(2048), flags: Array(12).fill('f'.repeat(256)) },
    }));
    submit();
    await screen.findByText('Model-reported risk: 100/100 (higher means more risk)');
    expect(screen.queryByText(/Assessment unavailable/)).not.toBeInTheDocument();
  });

  it.each([
    { label: 'more than six files', source: { ...sampleReview.source!, fileCount: 7 } },
    { label: 'more than 48 KiB of excerpts', source: { ...sampleReview.source!, bytes: 48 * 1024 + 1 } },
    { label: 'missing sample limitation', source: { ...sampleReview.source!, limitations: [] } },
  ])('rejects $label even after source opt-in', async ({ source }) => {
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    await openAndChoose();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include sampled README and source excerpts' }));
    (global.fetch as jest.Mock).mockResolvedValueOnce(assessmentResponse({ ...sampleReview, source }));
    submit();
    await screen.findByText('Assessment unavailable. Check the selected connection or try again later.');
    expect(screen.queryByText(malicious)).not.toBeInTheDocument();
  });

  it('shows an empty eligible list without auto-selecting a CLI or media model', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(models.slice(2)));
    render(<McpModelRiskAssessmentPanel repositoryUrl={repositoryUrl} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
    await screen.findByText(/No supported saved models/);
    expect(screen.getByRole('button', { name: 'Send evidence and assess' })).toBeDisabled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps GitHub typing and assessment independent from clone/install actions', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => url.includes('/api/model?') ? jsonResponse(models)
      : url.includes('model-risk-assessment') ? assessmentResponse() : jsonResponse({ success: true, mcpServersDir: 'mcp-servers' }));
    const onAdd = jest.fn(); const onHandoff = jest.fn();
    render(<GitHubTab onAdd={onAdd} onHandoff={onHandoff} onClose={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: repositoryUrl } });
    expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes('/api/model?') || String(url).includes('model-risk-assessment'))).toHaveLength(0);
    await openAndChoose(); submit(); await screen.findByText(malicious);
    expect(onAdd).not.toHaveBeenCalled(); expect(onHandoff).not.toHaveBeenCalled();
  });

  it('keeps Marketplace installation consent untouched even at score zero and closes requests with the dialog', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ success: true, servers: [{
      server: { name: 'example/tools', title: 'Assessment fixture', repository: { url: repositoryUrl }, packages: [{ registryType: 'npm', identifier: '@example/tools' }] },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    }], metadata: {} }));
    const onAdd = jest.fn(); const onHandoff = jest.fn();
    render(<MarketplaceTab onAdd={onAdd} onHandoff={onHandoff} onClose={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByText('Assessment fixture'));
    const consent = screen.getByRole('checkbox');
    const install = screen.getByRole('button', { name: /@example\/tools/ });
    await openAndChoose(); submit(); await screen.findByText(malicious);
    expect(consent).not.toBeChecked(); expect(install).toHaveAttribute('aria-disabled', 'true');
    expect(onAdd).not.toHaveBeenCalled(); expect(onHandoff).not.toHaveBeenCalled();
    const pending = deferred(); (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    submit();
    const lastCall = (global.fetch as jest.Mock).mock.calls.at(-1)!;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(lastCall[1].signal.aborted).toBe(true));
    await act(async () => { pending.resolve(assessmentResponse()); await pending.promise; });
    expect(screen.queryByText(malicious)).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled(); expect(onHandoff).not.toHaveBeenCalled();
  });

  it('provides all assessment copy in seven locales with matching placeholders', () => {
    const rows = Object.entries(mcpMessageRows).filter(([key]) => key.startsWith('mcp.modelRisk.'));
    expect(rows.length).toBeGreaterThan(35);
    for (const [, row] of rows) {
      expect(row).toHaveLength(7);
      const placeholders = [...row[0].matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
      for (const message of row) {
        expect(message.trim()).not.toBe('');
        expect([...message.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()).toEqual(placeholders);
      }
    }
  });
});
