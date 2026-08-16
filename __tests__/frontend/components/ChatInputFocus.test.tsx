import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

import ChatInput from '@/frontend/components/Chat/ChatInput';

/**
 * The chat page flips `disabled` on every conversation switch (details loading),
 * while a tool approval is pending and while the debugger is paused. Rendering the
 * textbox as contenteditable=false in those windows swallowed the user's click (so
 * they had to click a second time) and blurred the composer mid-typing.
 */
describe('ChatInput composer focus', () => {
  const editable = () => screen.getByLabelText('Message');

  it('keeps the textbox editable and focused while disabled', () => {
    const { rerender } = render(<ChatInput onSendMessage={() => undefined} />);

    const el = editable();
    expect(el).toHaveAttribute('contenteditable', 'true');

    act(() => { el.focus(); });
    expect(document.activeElement).toBe(el);

    rerender(<ChatInput onSendMessage={() => undefined} disabled />);

    expect(editable()).toHaveAttribute('contenteditable', 'true');
    expect(document.activeElement).toBe(editable());
  });

  it('does not send while disabled', () => {
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} disabled />);

    const el = editable();
    act(() => { el.focus(); });
    fireEvent.keyDown(el, { key: 'Enter' });

    expect(onSendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
