import {
  DEFAULT_WORKSPACE,
  WORKSPACE_CHANGED_EVENT,
  WORKSPACE_STORAGE_KEY,
  getSelectedWorkspace,
  onWorkspaceChanged,
  setSelectedWorkspace,
} from '@/frontend/utils/workspaceSelection';
import { navigateWorkspaceRoute } from '@/frontend/utils/workspaceNavigation';

describe('workspace frontend selection (#406)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('falls back to default for missing or malformed persisted selections', () => {
    expect(getSelectedWorkspace()).toBe(DEFAULT_WORKSPACE);

    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, '../escape');
    expect(getSelectedWorkspace()).toBe(DEFAULT_WORKSPACE);
  });

  it('persists a valid selection and notifies subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = onWorkspaceChanged(listener);

    setSelectedWorkspace('team-alpha');

    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('team-alpha');
    expect(listener).toHaveBeenCalledWith('team-alpha');

    unsubscribe();
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { workspace: 'other' } }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('workspace-aware page navigation', () => {
  it('uses a full navigation to another page or workspace when the mounted page has an explicit workspace', () => {
    const push = jest.fn();
    const assign = jest.fn();
    const pushState = jest.fn();

    navigateWorkspaceRoute(
      { push },
      '/flows?flow=default-agent-flujo&mode=edit&workspace=game-dev',
      { href: 'http://localhost/models?workspace=game-dev', assign },
      { pushState },
    );
    navigateWorkspaceRoute(
      { push },
      '/flows?flow=default-agent-flujo&mode=edit&workspace=team-space',
      { href: 'http://localhost/flows?workspace=game-dev', assign },
      { pushState },
    );

    expect(assign.mock.calls).toEqual([
      ['/flows?flow=default-agent-flujo&mode=edit&workspace=game-dev'],
      ['/flows?flow=default-agent-flujo&mode=edit&workspace=team-space'],
    ]);
    expect(push).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('stays on the page in the same workspace, so an unsaved new agent is not thrown away', () => {
    const push = jest.fn();
    const assign = jest.fn();
    const pushState = jest.fn();

    navigateWorkspaceRoute(
      { push },
      '/flows?flow=new-draft&mode=edit&workspace=game-dev',
      { href: 'http://localhost/flows?workspace=game-dev', assign },
      { pushState },
    );

    expect(pushState).toHaveBeenCalledWith(null, '', '/flows?flow=new-draft&mode=edit&workspace=game-dev');
    expect(assign).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps client-side routing when the current page has no explicit workspace', () => {
    const push = jest.fn();
    const assign = jest.fn();

    navigateWorkspaceRoute(
      { push },
      '/flows?flow=default-agent-flujo&mode=edit&workspace=default-workspace',
      { href: 'http://localhost/flows', assign },
    );

    expect(push).toHaveBeenCalledWith(
      '/flows?flow=default-agent-flujo&mode=edit&workspace=default-workspace',
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate again when an explicit editor URL resolves its deep link', () => {
    const push = jest.fn();
    const assign = jest.fn();
    const href = 'http://localhost/flows?flow=default-agent-flujo&mode=edit&workspace=game-dev';

    navigateWorkspaceRoute(
      { push },
      '/flows?flow=default-agent-flujo&mode=edit&workspace=game-dev',
      { href, assign },
    );

    expect(push).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
