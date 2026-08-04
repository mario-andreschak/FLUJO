import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('@mui/material', () => {
  const actual = jest.requireActual('@mui/material');
  return { ...actual, useMediaQuery: () => false };
});

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    disabled?: boolean;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

import ChatInput from '@/frontend/components/Chat/ChatInput';

const fileTransfer = (files: File[]) => ({
  files,
  types: ['Files'],
  dropEffect: 'none',
});

describe('ChatInput file drop', () => {
  it('adds all dropped files and sends them as attachments', async () => {
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);

    const dropzone = screen.getByTestId('chat-input-dropzone');
    const textFile = new File(['hello from a file'], 'notes.txt', { type: 'text/plain' });
    const imageFile = new File(['image bytes'], 'diagram.png', { type: 'image/png' });

    fireEvent.dragEnter(dropzone, { dataTransfer: fileTransfer([textFile, imageFile]) });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    fireEvent.drop(dropzone, { dataTransfer: fileTransfer([textFile, imageFile]) });

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(await screen.findByText('diagram.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
    const [, attachments] = onSendMessage.mock.calls[0];
    expect(attachments).toEqual([
      expect.objectContaining({
        type: 'document',
        content: 'hello from a file',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
      }),
      expect.objectContaining({
        type: 'image',
        content: expect.stringMatching(/^data:image\/png;base64,/),
        originalName: 'diagram.png',
        mimeType: 'image/png',
      }),
    ]);
  });

  it('prevents browser navigation but does not attach files while disabled', async () => {
    render(<ChatInput onSendMessage={() => undefined} disabled />);
    const dropzone = screen.getByTestId('chat-input-dropzone');
    const file = new File(['blocked'], 'blocked.txt', { type: 'text/plain' });

    const browserMayNavigate = fireEvent.drop(dropzone, { dataTransfer: fileTransfer([file]) });

    expect(browserMayNavigate).toBe(false);
    await waitFor(() => expect(screen.queryByText('blocked.txt')).not.toBeInTheDocument());
  });
});
