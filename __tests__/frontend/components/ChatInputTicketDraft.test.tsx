import React from 'react';
import { render, screen } from '@testing-library/react';
import { ticketDraftStorageKey } from '@/frontend/utils/workspaceContentKeys';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

import ChatInput from '@/frontend/components/Chat/ChatInput';

/**
 * "Ask FLUJO" on a ticket card hands the composer a one-shot draft (#379). The
 * composer must open with it already typed, and a later visit must start empty.
 */
describe('ChatInput ticket draft', () => {
  afterEach(() => sessionStorage.clear());

  it('opens with the handed-over draft and clears it for the next visit', () => {
    sessionStorage.setItem(ticketDraftStorageKey(), 'Please look at ticket 42');

    const { unmount } = render(<ChatInput onSendMessage={() => undefined} />);

    expect(screen.getByLabelText('Message')).toHaveTextContent('Please look at ticket 42');
    expect(sessionStorage.getItem(ticketDraftStorageKey())).toBeNull();

    unmount();
    render(<ChatInput onSendMessage={() => undefined} />);
    expect(screen.getByLabelText('Message')).toHaveTextContent('');
  });

  it('starts empty when there is no draft', () => {
    render(<ChatInput onSendMessage={() => undefined} />);
    expect(screen.getByLabelText('Message')).toHaveTextContent('');
  });
});
