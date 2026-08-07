import { fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

// FolderAssignMenu's new-folder dialog now renders DialogHeaderActions, which
// pulls in AskFlujoButton (useAskFlujo()) — mock the context so it doesn't
// throw outside an AskFlujoProvider (#369).
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';

function FolderMenuHarness({
  onCardClick,
  onAssign,
}: {
  onCardClick: () => void;
  onAssign: (folder: string | undefined) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  return (
    <div data-testid="card" onClick={onCardClick}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setAnchorEl(event.currentTarget);
        }}
      >
        Move to folder
      </button>
      <FolderAssignMenu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        currentFolder="Current"
        folders={['Current', 'Existing']}
        onClose={() => setAnchorEl(null)}
        onAssign={onAssign}
      />
    </div>
  );
}

describe('FolderAssignMenu', () => {
  it('does not activate its owning card when assigning an existing folder', () => {
    const onCardClick = jest.fn();
    const onAssign = jest.fn();
    render(<FolderMenuHarness onCardClick={onCardClick} onAssign={onAssign} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Existing' }));

    expect(onAssign).toHaveBeenCalledWith('Existing');
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('does not activate its owning card while creating a folder', () => {
    const onCardClick = jest.fn();
    const onAssign = jest.fn();
    render(<FolderMenuHarness onCardClick={onCardClick} onAssign={onAssign} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder…' }));
    fireEvent.click(screen.getByLabelText('Folder name'));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Created' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onAssign).toHaveBeenCalledWith('Created');
    expect(onCardClick).not.toHaveBeenCalled();
  });
});
