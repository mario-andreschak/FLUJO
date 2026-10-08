import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

// Slate cannot be typed into meaningfully under jsdom, so the composer is stubbed
// with a plain textarea that exposes the same imperative `focus()` handle. This
// pins ChatInput's contract: after a send the caret goes back into the composer.
jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ReactModule.forwardRef(function MockEditor(
      {
        value,
        onChange,
        ariaLabel,
        onKeyDown,
      }: {
        value: string;
        onChange: (value: string) => void;
        ariaLabel: string;
        onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
      },
      ref: React.Ref<{ insertText: (text: string) => void; focus: () => void }>,
    ) {
      const inner = ReactModule.useRef<HTMLTextAreaElement>(null);
      ReactModule.useImperativeHandle(ref, () => ({
        insertText: () => undefined,
        focus: () => inner.current?.focus(),
      }));
      return (
        <textarea
          ref={inner}
          aria-label={ariaLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown as unknown as React.KeyboardEventHandler<HTMLTextAreaElement>}
        />
      );
    }),
  };
});

import ChatInput from '@/frontend/components/Chat/ChatInput';

describe('ChatInput send focus', () => {
  it('returns focus to the composer after sending', () => {
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);

    const composer = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'hello world' } });

    // Clicking the send button moves DOM focus onto the button.
    const send = screen.getByRole('button', { name: 'Send message' });
    act(() => { send.focus(); });
    fireEvent.click(send);

    expect(onSendMessage).toHaveBeenCalledWith('hello world', []);
    expect(document.activeElement).toBe(screen.getByLabelText('Message'));
  });

  it('does not send (and does not steal focus) while disabled', () => {
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} disabled />);

    const composer = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'hello world' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
