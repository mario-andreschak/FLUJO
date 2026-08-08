import {
  DEFAULT_WORKSPACE,
  WORKSPACE_CHANGED_EVENT,
  WORKSPACE_STORAGE_KEY,
  getSelectedWorkspace,
  onWorkspaceChanged,
  setSelectedWorkspace,
} from '@/frontend/utils/workspaceSelection';

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
