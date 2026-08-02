import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ChatHistory from '@/frontend/components/Chat/ChatHistory';

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ visualStyle: 'modern' }),
}));

describe('ChatHistory', () => {
  it('keeps the delete action above the full-row conversation button', () => {
    const onDeleteConversation = jest.fn();
    const onSelectConversation = jest.fn();

    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[{
            id: 'conversation-1',
            title: 'Conversation one',
            flowId: null,
            createdAt: 1,
            updatedAt: 1,
            status: 'completed',
            source: 'chat',
          }]}
          currentConversationId="conversation-1"
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    const deleteButton = screen.getByRole('button', { name: 'Delete conversation' });
    const secondaryAction = deleteButton.closest('.MuiListItemSecondaryAction-root');

    expect(secondaryAction).not.toBeNull();
    expect(secondaryAction).toHaveStyle({ zIndex: '2' });

    fireEvent.click(deleteButton);
    expect(onDeleteConversation).toHaveBeenCalledWith('conversation-1');
    expect(onSelectConversation).not.toHaveBeenCalled();
  });
});
