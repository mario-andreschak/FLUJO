import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import WorkspaceBootstrap from '@/frontend/components/WorkspaceBootstrap';
import {
  WORKSPACE_STORAGE_KEY,
  __resetWorkspaceSelectionForTests,
  getSelectedWorkspace,
} from '@/frontend/utils/workspaceSelection';

describe('WorkspaceBootstrap deep links', () => {
  it('offers owner sign-in on unauthorized discovery without retrying or mounting providers', async () => {
    window.history.replaceState({}, '', '/chat?workspace=team-b');
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock });
    render(<WorkspaceBootstrap><div>private data mounted</div></WorkspaceBootstrap>);
    const link = await screen.findByRole('link', { name: 'Owner sign in' });
    expect(link).toHaveAttribute('href', '/owner/login?returnTo=%2Fchat%3Fworkspace%3Dteam-b');
    expect(screen.queryByText('private data mounted')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    __resetWorkspaceSelectionForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('validates and persists a top-level workspace before mounting providers', async () => {
    window.history.replaceState(
      {},
      '',
      '/chat?conversation=conversation-b&workspace=team-b',
    );
    window.localStorage.clear();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'team-a');

    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        workspaces: [
          { name: 'default-workspace' },
          { name: 'team-a' },
          { name: 'team-b' },
        ],
      }),
    })) as unknown as typeof fetch;
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(
      <WorkspaceBootstrap>
        <div>workspace data provider mounted</div>
      </WorkspaceBootstrap>,
    );

    await waitFor(() => {
      expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('team-b');
    });
    expect(await screen.findByText('workspace data provider mounted')).toBeInTheDocument();
    expect(getSelectedWorkspace()).toBe('team-b');
    expect(window.location.search).toContain('workspace=team-b');
  });

  it('uses a validated URL workspace when localStorage is unavailable without reloading', async () => {
    window.history.replaceState({}, '', '/chat?workspace=team-b');
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        workspaces: [
          { name: 'default-workspace' },
          { name: 'team-b' },
        ],
      }),
    })) as unknown as typeof fetch;
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(
      <WorkspaceBootstrap>
        <div>storage-free workspace mounted</div>
      </WorkspaceBootstrap>,
    );

    expect(await screen.findByText('storage-free workspace mounted')).toBeInTheDocument();
    expect(getSelectedWorkspace()).toBe('team-b');
    expect(window.location.search).toContain('workspace=team-b');
  });

  it('shows migration progress and keeps polling without mounting data providers early', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => '0' },
        json: async () => ({ code: 'WORKSPACE_LAYOUT_PREPARING' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ workspaces: [{ name: 'default-workspace' }] }),
      });
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(
      <WorkspaceBootstrap>
        <div>workspace provider mounted after migration</div>
      </WorkspaceBootstrap>,
    );

    expect(await screen.findByText(/Verifying and migrating workspace data/)).toBeInTheDocument();
    expect(screen.queryByText('workspace provider mounted after migration')).not.toBeInTheDocument();
    expect(await screen.findByText('workspace provider mounted after migration')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
