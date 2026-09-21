/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RoleActionMenu from '@/frontend/components/Roles/RoleActionMenu';
import RoleVersionHistory from '@/frontend/components/Roles/RoleVersionHistory';
import { rolesService } from '@/frontend/services/roles';
import type { PublicRole, RoleImpactPreview } from '@/shared/types/enduringAgent';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/frontend/services/roles', () => ({
  RolesApiError: class extends Error {},
  rolesService: { remove: jest.fn(), rollback: jest.fn(), versions: jest.fn() },
}));

const role = { id: 'role-test', name: 'Test Role', currentVersionId: 'version-2', archived: false } as PublicRole;
const impact = { hardDeleteAllowed: true } as RoleImpactPreview;

beforeEach(() => jest.resetAllMocks());

it('cancels Role deletion safely, then retains failure for retry and blocks duplicate requests', async () => {
  const onDeleted = jest.fn();
  render(<RoleActionMenu role={role} impact={impact} onChanged={jest.fn()} onDeleted={onDeleted} />);
  const trigger = screen.getByRole('button');
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  let dialog = screen.getByRole('dialog', { name: 'Delete permanently' });
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  expect(rolesService.remove).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  dialog = screen.getByRole('dialog');
  jest.mocked(rolesService.remove).mockRejectedValueOnce(new Error('temporary failure'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  expect(onDeleted).not.toHaveBeenCalled();
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete permanently' })).toBeEnabled());
  let finish!: () => void;
  jest.mocked(rolesService.remove).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(rolesService.remove).toHaveBeenCalledTimes(2);
  expect(rolesService.remove).toHaveBeenLastCalledWith('role-test', 'version-2');
  await act(async () => finish());
  await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
});

it('names the selected Role version and confirms rollback without replaying a failed history refresh', async () => {
  jest.mocked(rolesService.versions).mockResolvedValueOnce({ versions: [{
    ...role, id: 'version-1', roleId: role.id, version: 1, prompt: 'Earlier instructions', behaviors: [], current: false,
  }] } as Awaited<ReturnType<typeof rolesService.versions>>).mockRejectedValueOnce(new Error('history unavailable'));
  jest.mocked(rolesService.rollback).mockResolvedValue({ ...role, currentVersionId: 'version-3' });
  const onChanged = jest.fn();
  render(<RoleVersionHistory role={role} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced and history' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use this version' }));
  const dialog = screen.getByRole('dialog', { name: 'Use this version — Version 1' });
  expect(within(dialog).getByText(/Existing Personas will not change/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(rolesService.rollback).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: 'Use this version' });
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Use this version' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ currentVersionId: 'version-3' }));
  expect(rolesService.rollback).toHaveBeenCalledTimes(1);
  expect(rolesService.rollback).toHaveBeenCalledWith('role-test', { expectedCurrentVersionId: 'version-2', sourceVersionId: 'version-1' });
  expect(screen.getByRole('alert')).toBeInTheDocument();
});
