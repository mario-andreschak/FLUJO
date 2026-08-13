import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';

describe('CardPickerDialog', () => {
  it('has an accessible title and restores focus to the opening trigger', async () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} onClick={() => setOpen(true)}>Choose role</button>
          <CardPickerDialog
            open={open}
            onClose={() => setOpen(false)}
            title="Roles"
            description="Choose one role"
            restoreFocusRef={triggerRef}
            items={[{ key: 'role', content: <div>Engineer</div> }]}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Choose role' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Roles' })).toHaveAccessibleDescription('Choose one role');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes on Escape', () => {
    const onClose = jest.fn();
    render(
      <CardPickerDialog
        open
        onClose={onClose}
        ariaLabel="Apps"
        items={[{ key: 'app', content: <div>Calendar</div> }]}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Apps' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
