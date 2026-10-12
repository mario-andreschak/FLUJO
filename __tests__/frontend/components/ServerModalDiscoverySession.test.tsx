import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServerModal from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal';
import { __resetWorkspaceSelectionForTests, setSelectedWorkspace } from '@/frontend/utils/workspaceSelection';

const configureProps = jest.fn();

jest.mock('@/frontend/components/shared/DialogHeaderActions', () => ({ __esModule: true, default: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close setup</button> }));

jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/SpotlightTab', () => ({ __esModule: true, default: () => <div>Spotlight destination</div> }));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/GitHubTab', () => ({ __esModule: true, default: () => <div>GitHub destination</div> }));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab', () => ({ __esModule: true, default: (props: unknown) => { configureProps(props); return <div>Configure destination</div>; } }));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/RemoteTab', () => ({ __esModule: true, default: () => <div>Remote destination</div> }));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ReferenceServersTab', () => ({ __esModule: true, default: () => <div>Reference destination</div> }));

const local = { server: { name: 'io.example/local', title: 'Local tools', repository: { url: 'https://github.com/example/tools', source: 'github' }, packages: [{ registryType: 'npm', identifier: '@example/local' }] } };
const remote = { server: { name: 'io.example/remote', title: 'Remote tools', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] } };
const response = (servers: unknown[], nextCursor?: string) => ({ ok: true, json: async () => ({ success: true, servers, metadata: { nextCursor } }) });
const props = { onClose: jest.fn(), onAdd: jest.fn(), isOpen: true, initialTab: 'marketplace' as const };
function deferred() {
  type JsonResponse = { ok: boolean; json: () => Promise<unknown> };
  let resolve!: (value: JsonResponse) => void;
  const promise = new Promise<JsonResponse>(done => { resolve = done; });
  return { promise, resolve };
}
async function search() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'tools' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('Local tools');
}
async function detail() {
  await search();
  fireEvent.click(screen.getByRole('button', { name: /L Local tools/ }));
  await screen.findByRole('button', { name: 'AI risk assessment' });
}
async function chooseModel() {
  fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment' }));
  await screen.findByRole('option', { name: 'Text model' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Assessment model' }), { target: { value: 'text' } });
}
const modelResponse = { ok: true, json: async () => [{ id: 'text', name: 'Text model', adapter: 'openai', provider: 'openai' }] };
const assessmentResponse = { ok: true, json: async () => ({ success: true, review: {
  status: 'assessed', model: { id: 'text', name: 'Text model' }, assessment: { score: 23, rationale: 'Completed advisory evidence', flags: [] },
  source: { repositoryUrl: local.server.repository.url, revision: 'a'.repeat(40), evidenceDigest: 'b'.repeat(64), capturedAt: '2026-10-09T20:00:00Z',
    repository: { stars: 1, forks: 0, lastCommitAt: null, openIssues: 0, closedIssues: 0, openIssueRatio: null },
    author: { login: 'example', type: 'User', followers: null, publicRepositories: null, createdAt: null, accountAgeDays: null },
    limitations: ['signalsOnly'], fileCount: 0, bytes: 0 },
} }) };

describe('ServerModal discovery session', () => {
  beforeEach(() => {
    __resetWorkspaceSelectionForTests(); window.localStorage.clear(); jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue(response([local, remote], 'page-two'));
  });
  afterEach(() => { jest.restoreAllMocks(); __resetWorkspaceSelectionForTests(); });

  it('preserves draft, committed pages and filters while another setup tab is open', async () => {
    render(<ServerModal isOpen onClose={jest.fn()} onAdd={jest.fn()} initialTab="marketplace" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Local tools');
    (global.fetch as jest.Mock).mockResolvedValueOnce(response([{ server: { ...local.server, name: 'io.example/second', title: 'Second local tools' } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Second local tools');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'unsubmitted draft' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Local package' }));
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    expect(screen.getByText('GitHub destination')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Search MCP servers' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue('unsubmitted draft'));
    expect(screen.getByText('Showing 2 of 3 loaded servers')).toBeInTheDocument();
    expect(screen.getByText('Local tools')).toBeInTheDocument();
    expect(screen.getByText('Second local tools')).toBeInTheDocument();
    expect(screen.queryByText('Remote tools')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('initializes discovery only on visit and never searches while typing or returning', () => {
    render(<ServerModal {...props} initialTab="spotlight" />);
    expect(screen.queryByRole('textbox', { name: 'Search MCP servers', hidden: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'draft only' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Remote' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }));
    expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue('draft only');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('aborts pending pagination on hide and rejects a late response without replaying it', async () => {
    render(<ServerModal {...props} />);
    await search();
    const pending = deferred();
    (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    const signal = (global.fetch as jest.Mock).mock.calls[1][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response([{ server: { ...local.server, name: 'late', title: 'Late result' } }])));
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }));
    expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue('tools');
    expect(screen.getByText('Showing 2 of 2 loaded servers')).toBeInTheDocument();
    expect(screen.queryByText('Late result')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
    expect(screen.getByText('Search stopped when you left this tab. Search again to refresh the results.')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh session when a reused modal parent closes and reopens', async () => {
    const { rerender } = render(<ServerModal {...props} />);
    await search();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Local package' }));
    rerender(<ServerModal {...props} isOpen={false} />);
    rerender(<ServerModal {...props} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue(''));
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(screen.queryByText('Local tools')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('resets workspace-owned discovery and discards completions from the previous workspace', async () => {
    render(<ServerModal {...props} />);
    const pending = deferred(); (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'old workspace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal;
    act(() => setSelectedWorkspace('new-workspace'));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response([local])));
    expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue('');
    expect(screen.queryByText('Local tools')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves detail selection, chosen model and completed advisory evidence without hidden portals', async () => {
    const { rerender } = render(<ServerModal {...props} />);
    await detail();
    (global.fetch as jest.Mock).mockResolvedValueOnce(modelResponse);
    await chooseModel();
    (global.fetch as jest.Mock).mockResolvedValueOnce(assessmentResponse);
    fireEvent.click(screen.getByRole('button', { name: 'Send evidence and assess' }));
    await screen.findByText('Completed advisory evidence');
    expect(screen.getByRole('checkbox', { name: 'I understand the risk and trust this server' })).not.toBeChecked();
    rerender(<ServerModal {...props} initialTab="github" />);
    await screen.findByText('GitHub destination');
    expect(screen.queryByRole('button', { name: 'AI risk assessment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Assessment model' })).not.toBeInTheDocument();
    const hiddenSend = screen.getByRole('button', { name: 'Send evidence and assess', hidden: true });
    expect(hiddenSend).toBeDisabled(); fireEvent.click(hiddenSend);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    rerender(<ServerModal {...props} />);
    expect(await screen.findByText('Completed advisory evidence')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Assessment model' })).toHaveValue('text');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('cancels an actual pending model request on tab hide and preserves its picker for a manual retry', async () => {
    const { rerender } = render(<ServerModal {...props} />);
    await detail(); (global.fetch as jest.Mock).mockResolvedValueOnce(modelResponse); await chooseModel();
    const pending = deferred(); (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Send evidence and assess' }));
    const signal = (global.fetch as jest.Mock).mock.calls[2][1].signal as AbortSignal;
    rerender(<ServerModal {...props} initialTab="remote" />);
    await screen.findByText('Remote destination'); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(assessmentResponse));
    rerender(<ServerModal {...props} />);
    expect(await screen.findByText('Assessment cancelled.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Assessment model' })).toHaveValue('text');
    expect(screen.queryByText('Completed advisory evidence')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('closes filter portals on tab hide while preserving the chosen filter', async () => {
    const { rerender } = render(<ServerModal {...props} />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Type' }));
    await screen.findByRole('option', { name: 'Local package' });
    rerender(<ServerModal {...props} initialTab="github" />);
    await screen.findByText('GitHub destination');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    rerender(<ServerModal {...props} />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps the explicit trust gate and configure handoff while retaining discovery pages', async () => {
    render(<ServerModal {...props} />);
    await detail();
    const install = screen.getByRole('button', { name: /npm/ });
    expect(install).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(install); expect(configureProps).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand the risk and trust this server' }));
    fireEvent.click(install);
    await screen.findByText('Configure destination');
    expect(configureProps).toHaveBeenLastCalledWith(expect.objectContaining({ autoTestRun: true, initialConfig: expect.objectContaining({ command: 'npx' }) }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Marketplace' })).toBeVisible());
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }));
    expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue('tools');
    fireEvent.click(screen.getByRole('tab', { name: 'Configure & Test' }));
    expect(configureProps).toHaveBeenLastCalledWith(expect.objectContaining({ autoTestRun: false }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
