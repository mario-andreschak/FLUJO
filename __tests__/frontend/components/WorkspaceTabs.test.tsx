import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkspaceTabs from '@/frontend/components/Navigation/WorkspaceTabs';

const selectWorkspace = jest.fn();
const createWorkspace = jest.fn(async (_name: string) => undefined);
const renameWorkspace = jest.fn(async (_name: string, _newName: string) => undefined);
const editWorkspace = jest.fn(async (_name: string, _newName: string, _roots: string[]) => undefined);
const removeWorkspace = jest.fn(async (_name: string) => undefined);

jest.mock('@/frontend/hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [
      { name: 'default-workspace', color: '#6656E8', isDefault: true, roots: [] },
      { name: 'research', color: '#10A8C3', isDefault: false, roots: ['/projects/research'] },
    ],
    selected: 'research',
    select: selectWorkspace,
    create: createWorkspace,
    rename: renameWorkspace,
    edit: editWorkspace,
    remove: removeWorkspace,
    loading: false,
  }),
}));

describe('WorkspaceTabs workspace menu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: 'Current workspace: research' }));
  }

  it('renders an always-available Workspaces button and protects the default workspace', () => {
    render(<WorkspaceTabs />);
    expect(screen.getByText('Workspaces')).toBeInTheDocument();

    openMenu();
    expect(screen.getByText('default-workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit default-workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete default-workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit research' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete research' })).toBeInTheDocument();
  });

  it('selects a workspace from the list', () => {
    render(<WorkspaceTabs />);
    openMenu();

    fireEvent.click(screen.getByText('default-workspace'));
    expect(selectWorkspace).toHaveBeenCalledWith('default-workspace');
  });

  it('creates and edits workspaces from validated dialogs', async () => {
    render(<WorkspaceTabs />);
    openMenu();
    fireEvent.click(screen.getByText('Create workspace'));
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'team-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith('team-a'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Edit research' }));
    expect(screen.getByText('/projects/research')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(editWorkspace).toHaveBeenCalledWith(
      'research',
      'planning',
      ['/projects/research'],
    ));
  });

  it('requires confirmation before permanently deleting a workspace', async () => {
    render(<WorkspaceTabs />);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Delete research' }));

    expect(screen.getByText(/permanently deletes “research”/i)).toBeInTheDocument();
    expect(removeWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));

    await waitFor(() => expect(removeWorkspace).toHaveBeenCalledWith('research'));
  });
});
