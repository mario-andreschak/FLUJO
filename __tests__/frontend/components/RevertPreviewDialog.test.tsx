/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RevertPreviewDialog from '@/frontend/components/Chat/RevertPreviewDialog';

const previewRevert = jest.fn();
const revertToMessage = jest.fn();
const undoRevert = jest.fn();

jest.mock('@/frontend/services/chat', () => ({
  chatService: {
    previewRevert: (...args: unknown[]) => previewRevert(...args),
    revertToMessage: (...args: unknown[]) => revertToMessage(...args),
    undoRevert: (...args: unknown[]) => undoRevert(...args),
  },
}));

const copy: Record<string, string> = {
  'chat.revert.title': 'Restore to here',
  'chat.revert.chooseMode': 'Choose what to restore',
  'chat.revert.mode.chatAndFiles': 'Restore Chat + Files',
  'chat.revert.mode.filesOnly': 'Restore Only Files + Keep Chat Where It Is',
  'chat.revert.mode.chatOnly': 'Restore Only Chat + Keep Files How They Are',
  'chat.revert.nonFileWarning': 'Non-file tools may have changed databases, APIs, emails, browser state, remote services, or other external systems.',
  'chat.revert.restrictionsTitle': 'Restore boundaries',
  'chat.revert.chatBoundary': 'Chat restore removes the selected message and {count} message(s) in total from that point onward.',
  'chat.revert.fileBoundary': 'File restore covers only the listed files in one snapshot-enabled Git root.',
  'chat.revert.runningRestriction': 'Restore is available only after the conversation has stopped running.',
  'chat.revert.review': 'Review affected files.',
  'chat.revert.noDiff': 'No textual diff available.',
  'chat.revert.truncated': 'Preview truncated for safety.',
  'chat.revert.confirm': 'Confirm restore',
  'chat.revert.success': 'Restore complete.',
  'chat.revert.undo': 'Undo restore',
  'common.cancel': 'Cancel',
};

const mockTranslate = (key: string, values?: Record<string, unknown>) => {
  let value = copy[key] ?? key;
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
};

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: mockTranslate }),
}));

describe('RevertPreviewDialog', () => {
  beforeEach(() => {
    previewRevert.mockReset();
    revertToMessage.mockReset();
    undoRevert.mockReset();
    previewRevert.mockResolvedValue({
      messageId: 'm1',
      previewId: 'preview-1',
      files: [{ path: 'src/file.ts', status: 'M' }],
      diff: '-old\n+new',
      truncated: false,
      fileRestoreAvailable: true,
      chatMessageCount: 3,
    });
    revertToMessage.mockResolvedValue({
      operationId: 'operation-1',
      restoredChat: false,
      restoredFiles: true,
    });
  });

  it('shows all restore modes, boundaries, and the non-file side-effect warning', async () => {
    render(
      <RevertPreviewDialog
        open
        conversationId="conversation-1"
        messageId="m1"
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByRole('radio', { name: 'Restore Chat + Files' })).toBeChecked();
    expect(await screen.findByRole('radio', { name: 'Restore Only Files + Keep Chat Where It Is' })).toBeEnabled();
    expect(await screen.findByRole('radio', { name: 'Restore Only Chat + Keep Files How They Are' })).toBeEnabled();
    expect(await screen.findByText(/Non-file tools may have changed databases/)).toBeInTheDocument();
    expect(await screen.findByText(/3 message\(s\)/)).toBeInTheDocument();

    const filesOnly = screen.getByRole('radio', { name: 'Restore Only Files + Keep Chat Where It Is' });
    fireEvent.click(filesOnly);
    await waitFor(() => expect(filesOnly).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));

    await waitFor(() => expect(revertToMessage).toHaveBeenCalledWith(
      'conversation-1',
      'm1',
      'preview-1',
      'files-only',
    ));
  });
});
