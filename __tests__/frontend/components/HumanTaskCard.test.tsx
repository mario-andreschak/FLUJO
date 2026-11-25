import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import HumanTaskCard from '@/frontend/components/Chat/HumanTaskCard';
import type { HumanTaskCallArguments } from '@/utils/shared/humanStep';

const base: HumanTaskCallArguments = {
  requestId: 'req-1',
  nodeId: 'review',
  mode: 'approval',
  title: 'Check the email',
  prompt: 'Send this email?',
  candidate: 'Dear Ben, the meeting moves to Friday.',
  digest: 'sha256:abc',
  expiresAt: '2030-01-01T10:00:00.000Z',
};

const renderCard = (task: Partial<HumanTaskCallArguments>, result: { ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> } = { ok: true }) => {
  const onAnswer = jest.fn(async () => result);
  render(<HumanTaskCard toolCallId="call-1" task={{ ...base, ...task }} onAnswer={onAnswer} />);
  return { onAnswer };
};

describe('HumanTaskCard', () => {
  it('shows the question, what to approve and the deadline, with labelled buttons', () => {
    renderCard({});

    expect(screen.getByText('Check the email')).toBeInTheDocument();
    expect(screen.getByText('Send this email?')).toBeInTheDocument();
    expect(screen.getByText('Dear Ben, the meeting moves to Friday.')).toBeInTheDocument();
    expect(screen.getByText(/Answer by/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('approves with the digest of what was shown', async () => {
    const { onAnswer } = renderCard({});

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });

    expect(onAnswer).toHaveBeenCalledWith(
      { toolCallId: 'call-1', requestId: 'req-1' }, 'approve', expect.objectContaining({ digest: 'sha256:abc' }),
    );
    expect(screen.getByText('Answer saved. The flow goes on.')).toBeInTheDocument();
  });

  it('sends the changed text in edit mode', async () => {
    const { onAnswer } = renderCard({ mode: 'edit' });

    fireEvent.change(screen.getByLabelText('Change the text if needed'), { target: { value: 'Dear Ben, see you Monday.' } });
    expect(screen.getByText('You changed the text. Your version is what goes on.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })); });

    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), 'approve', expect.objectContaining({ value: 'Dear Ben, see you Monday.' }));
  });

  it('checks answers before sending and points at the question to fix', async () => {
    const { onAnswer } = renderCard({
      mode: 'input',
      candidate: undefined,
      fields: [{ name: 'seats', label: 'Seats', type: 'integer', required: true, min: 1, max: 8 }],
    });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })); });

    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText('This answer is needed.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Seats/)).toHaveFocus();
  });

  it('keeps what was typed when the server refuses the answer', async () => {
    const { onAnswer } = renderCard({
      mode: 'input',
      candidate: undefined,
      fields: [{ name: 'note', label: 'Note', type: 'text', required: true }],
    }, { ok: false, error: 'Some answers need a fix.', fieldErrors: { note: 'Too short for us.' } });

    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'ok' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })); });

    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), 'approve', expect.objectContaining({ value: { note: 'ok' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Some answers need a fix.');
    expect(screen.getByText('Too short for us.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Note/)).toHaveValue('ok');
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled();
  });

  it('turns a step down without checking the answers', async () => {
    const { onAnswer } = renderCard({
      mode: 'input',
      candidate: undefined,
      fields: [{ name: 'seats', label: 'Seats', type: 'integer', required: true }],
    });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn down' })); });

    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), 'reject', expect.not.objectContaining({ value: expect.anything() }));
  });
});
