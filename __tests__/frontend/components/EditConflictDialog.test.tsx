/**
 * "Someone else saved first" (#575): the dialog explains who saved, lets the
 * person compare, load their version or save theirs anyway.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import EditConflictDialog from '@/frontend/components/shared/sharedEditing/EditConflictDialog';
import EditConflictHost from '@/frontend/components/shared/sharedEditing/EditConflictHost';
import { announceEditConflict, type EditConflict } from '@/frontend/services/sharedItems';
import { act } from 'react';

const conflict: EditConflict = {
  kind: 'model',
  itemId: 'm1',
  message: 'Ben saved this model while you were editing it.',
  currentRevision: 'hdef',
  changedBy: { name: 'Ben', at: 1_800_000_000_000 },
  current: { id: 'm1', displayName: 'Theirs', temperature: '0.5' },
};

it('explains who saved first and offers every choice', () => {
  const onLoadTheirs = jest.fn();
  const onSaveMine = jest.fn();
  const onClose = jest.fn();
  render(<EditConflictDialog conflict={conflict} mine={{ id: 'm1', displayName: 'Mine', temperature: '0.5' }}
    onLoadTheirs={onLoadTheirs} onSaveMine={onSaveMine} onClose={onClose} />);

  expect(screen.getByText('Someone else saved first')).toBeTruthy();
  expect(screen.getByText(/Ben saved this/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  const table = screen.getByRole('table', { name: /Differences/ });
  expect(table.textContent).toContain('displayName');
  expect(table.textContent).toContain('Mine');
  expect(table.textContent).toContain('Theirs');
  expect(table.textContent).not.toContain('temperature');

  fireEvent.click(screen.getByRole('button', { name: 'Save mine anyway' }));
  expect(onSaveMine).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Load their version' }));
  expect(onLoadTheirs).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('stays closed without a conflict', () => {
  render(<EditConflictDialog conflict={null} mine={null} onLoadTheirs={jest.fn()} onSaveMine={jest.fn()} onClose={jest.fn()} />);
  expect(screen.queryByText('Someone else saved first')).toBeNull();
});

it('answers a refused MCP server save announced by the save service', async () => {
  const onReload = jest.fn();
  const saveMine = jest.fn(async () => true);
  render(<EditConflictHost kind="mcp-server" onReload={onReload} />);
  act(() => {
    announceEditConflict({ conflict: { ...conflict, kind: 'mcp-server', itemId: 'github' }, mine: { command: 'mine' }, saveMine });
  });
  expect(screen.getByText('Someone else saved first')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save mine anyway' }));
  });
  expect(saveMine).toHaveBeenCalledTimes(1);
  expect(onReload).toHaveBeenCalled();
});
