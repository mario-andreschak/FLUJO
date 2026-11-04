import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatProjectChip from '@/frontend/components/Projects/ChatProjectChip';

const git = {
  repoRoot: 'C:\\code\\app',
  branch: 'main',
  head: 'abc1234',
  changes: 3,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  branches: ['main', 'feat/x'],
  remoteBranches: [],
  worktrees: [
    { path: 'C:\\code\\app', branch: 'main', head: 'abc1234', main: true, managed: false },
    { path: 'C:\\code\\app.worktrees\\feat-x', branch: 'feat/x', head: 'def5678', main: false, managed: true },
    { path: 'C:\\agents\\other-tool', branch: 'agent/run', head: '0a0a0a0', main: false, managed: false },
  ],
};

const state = {
  projects: [{ path: 'C:\\code\\app', name: 'app', git }],
  activeProject: 'C:\\code\\app',
  chat: { project: 'C:\\code\\app', path: 'C:\\code\\app', pinned: true, git },
};

describe('ChatProjectChip', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => state }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('shows the chat folder, branch and change count', async () => {
    render(<ChatProjectChip conversationId="chat-1" />);
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('•3')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects?conversationId=chat-1');
  });

  it('moves the chat into a worktree and blocks branch switches on a dirty tree', async () => {
    render(<ChatProjectChip conversationId="chat-1" />);
    fireEvent.click(await screen.findByText('app'));

    expect(screen.getByRole('menuitem', { name: /switch branch/i })).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(screen.getByRole('menuitem', { name: /feat-x/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST' })));
    const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/projects' && init?.method === 'POST');
    expect(JSON.parse(post![1].body)).toEqual({
      action: 'bindChat',
      conversationId: 'chat-1',
      path: 'C:\\code\\app.worktrees\\feat-x',
    });
  });

  it('folds away other tools\' worktrees and never offers to remove them', async () => {
    render(<ChatProjectChip conversationId="chat-1" />);
    fireEvent.click(await screen.findByText('app'));

    expect(screen.getByRole('button', { name: /remove worktree feat-x/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /other-tool/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /other worktrees \(1\)/i }));
    expect(screen.getByRole('menuitem', { name: /other-tool/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove worktree other-tool/i })).not.toBeInTheDocument();
  });
});
