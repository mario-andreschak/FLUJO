import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('@/frontend/services/model', () => ({
  modelService: {
    loadModels: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@/frontend/utils/bugReportContext', () => ({
  collectBugReportContext: jest.fn().mockResolvedValue({
    appVersion: '1.0.0',
    installMode: 'test',
    browser: 'jest',
    os: 'test-os',
    page: '/test',
  }),
}));

jest.mock('@/frontend/utils/openGitHubIssue', () => ({
  openGitHubNewIssue: jest.fn(),
}));

jest.mock('@/frontend/services/bugReport', () => ({
  bugReportService: {
    enhance: jest.fn(),
  },
}));

jest.mock('@/shared/types/bugReport', () => ({
  formatContextBlock: jest.fn(() => '```\nenv: jest\n```'),
}));

import BugReportButton from '@/frontend/components/BugReport/BugReportButton';
import { openGitHubNewIssue } from '@/frontend/utils/openGitHubIssue';

const openDialog = async () => {
  render(<BugReportButton />);
  fireEvent.click(screen.getByRole('button', { name: 'bugReport.action' }));
  return {
    titleInput: (await screen.findByLabelText('common.title')) as HTMLInputElement,
    descriptionInput: screen.getByLabelText('common.description') as HTMLInputElement,
  };
};

describe('BugReportButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-focuses the title field when the dialog opens', async () => {
    const { titleInput } = await openDialog();
    await waitFor(() => expect(titleInput).toHaveFocus());
  });

  it('hides the title clear button when empty and shows it once text is typed', async () => {
    const { titleInput } = await openDialog();
    expect(screen.queryByRole('button', { name: 'bugReport.clearTitle' })).not.toBeInTheDocument();

    fireEvent.change(titleInput, { target: { value: 'abc' } });
    expect(await screen.findByRole('button', { name: 'bugReport.clearTitle' })).toBeInTheDocument();
  });

  it('clears the title field and returns focus to it', async () => {
    const { titleInput } = await openDialog();
    fireEvent.change(titleInput, { target: { value: 'abc' } });

    const clearButton = await screen.findByRole('button', { name: 'bugReport.clearTitle' });
    fireEvent.click(clearButton);

    expect(titleInput.value).toBe('');
    await waitFor(() => expect(titleInput).toHaveFocus());
  });

  it('clears the description field and re-disables the submit button', async () => {
    const { descriptionInput } = await openDialog();
    fireEvent.change(descriptionInput, { target: { value: 'something happened' } });

    const submitButton = screen.getByRole('button', { name: 'feedback.openGitHub' });
    expect(submitButton).toBeEnabled();

    const clearButton = await screen.findByRole('button', { name: 'bugReport.clearDescription' });
    fireEvent.click(clearButton);

    expect(descriptionInput.value).toBe('');
    expect(submitButton).toBeDisabled();
    await waitFor(() => expect(descriptionInput).toHaveFocus());
  });

  it('clearing the title field does not affect the description field, and vice versa', async () => {
    const { titleInput, descriptionInput } = await openDialog();
    fireEvent.change(titleInput, { target: { value: 'a title' } });
    fireEvent.change(descriptionInput, { target: { value: 'a description' } });

    fireEvent.click(await screen.findByRole('button', { name: 'bugReport.clearTitle' }));
    expect(titleInput.value).toBe('');
    expect(descriptionInput.value).toBe('a description');

    fireEvent.click(await screen.findByRole('button', { name: 'bugReport.clearDescription' }));
    expect(descriptionInput.value).toBe('');
  });

  it('submits via Ctrl+Enter from the description field', async () => {
    const { titleInput, descriptionInput } = await openDialog();
    fireEvent.change(titleInput, { target: { value: 'My bug' } });
    fireEvent.change(descriptionInput, { target: { value: 'It broke' } });

    fireEvent.keyDown(descriptionInput, { key: 'Enter', ctrlKey: true });

    expect(openGitHubNewIssue).toHaveBeenCalledTimes(1);
    expect(openGitHubNewIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'My bug',
        body: expect.stringContaining('It broke'),
        labels: ['bug'],
      })
    );
  });

  it('submits via Ctrl+Enter from the title field', async () => {
    const { titleInput, descriptionInput } = await openDialog();
    fireEvent.change(descriptionInput, { target: { value: 'It broke' } });

    fireEvent.keyDown(titleInput, { key: 'Enter', ctrlKey: true });

    expect(openGitHubNewIssue).toHaveBeenCalledTimes(1);
  });

  it('submits via Cmd+Enter (metaKey) as well', async () => {
    const { descriptionInput } = await openDialog();
    fireEvent.change(descriptionInput, { target: { value: 'It broke' } });

    fireEvent.keyDown(descriptionInput, { key: 'Enter', metaKey: true });

    expect(openGitHubNewIssue).toHaveBeenCalledTimes(1);
  });

  it('does not submit on plain Enter in the description field', async () => {
    const { descriptionInput } = await openDialog();
    fireEvent.change(descriptionInput, { target: { value: 'It broke' } });

    fireEvent.keyDown(descriptionInput, { key: 'Enter' });

    expect(openGitHubNewIssue).not.toHaveBeenCalled();
  });

  it('does not submit on Ctrl+Enter when the description is empty', async () => {
    const { titleInput } = await openDialog();
    fireEvent.change(titleInput, { target: { value: 'My bug' } });

    fireEvent.keyDown(titleInput, { key: 'Enter', ctrlKey: true });

    expect(openGitHubNewIssue).not.toHaveBeenCalled();
  });

  it('resets the fields when the dialog is closed and reopened', async () => {
    const { titleInput, descriptionInput } = await openDialog();
    fireEvent.change(titleInput, { target: { value: 'My bug' } });
    fireEvent.change(descriptionInput, { target: { value: 'It broke' } });

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    const reopenButton = await screen.findByRole('button', { name: 'bugReport.action' });
    fireEvent.click(reopenButton);

    const reopenedTitle = (await screen.findByLabelText('common.title')) as HTMLInputElement;
    const reopenedDescription = (await screen.findByLabelText('common.description')) as HTMLInputElement;
    expect(reopenedTitle.value).toBe('');
    expect(reopenedDescription.value).toBe('');
  });

  it('still appends the safe context block to the submitted body', async () => {
    const { descriptionInput } = await openDialog();
    fireEvent.change(descriptionInput, { target: { value: 'It broke' } });

    fireEvent.keyDown(descriptionInput, { key: 'Enter', ctrlKey: true });

    expect(openGitHubNewIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('```'),
      })
    );
  });
});
