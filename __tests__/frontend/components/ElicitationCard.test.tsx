import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ElicitationCard } from '@/frontend/components/Chat/ElicitationCard';
import { translate } from '@/frontend/i18n/core';
import { SUPPORTED_LOCALES } from '@/frontend/i18n/locales';
import type { TranslationKey } from '@/frontend/i18n';

const link = {
  elicitationId: 'link-1',
  mode: 'url' as const,
  serverName: 'payments',
  message: 'Confirm the payment with your bank.',
  url: 'https://bank.example.com/confirm?ref=42',
};

describe('ElicitationCard (#1448)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('shows the site and the full link, and opens it only on a click', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    const onDone = jest.fn();
    const onDecline = jest.fn();
    render(<ElicitationCard elicitation={link} onDone={onDone} onDecline={onDecline} onCancel={jest.fn()} />);

    expect(screen.getByText('Asked by payments')).toBeInTheDocument();
    expect(screen.getByTestId('elicitation-url-host')).toHaveTextContent('bank.example.com');
    expect(screen.getByTestId('elicitation-url')).toHaveTextContent('https://bank.example.com/confirm?ref=42');
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'I’ve finished' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(open).toHaveBeenCalledWith('https://bank.example.com/confirm?ref=42', '_blank', 'noopener,noreferrer');
    fireEvent.click(screen.getByRole('button', { name: 'I’ve finished' }));
    expect(onDone).toHaveBeenCalledWith('link-1');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalledWith('link-1');
    open.mockRestore();
  });

  it('warns about look-alike hosts and will not open an unsafe link', () => {
    const { rerender } = render(<ElicitationCard elicitation={{ ...link, url: 'https://xn--pple-43d.com/' }} />);
    expect(screen.getByText(/imitate another website/)).toBeInTheDocument();
    rerender(<ElicitationCard elicitation={{ ...link, url: 'javascript:alert(1)' }} />);
    expect(screen.getByText(/not a safe web address/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open link' })).toBeDisabled();
  });

  it('checks required fields before sending a form', () => {
    const onSubmit = jest.fn();
    render(<ElicitationCard
      elicitation={{
        elicitationId: 'form-1', mode: 'form', message: 'Shipping details',
        requestedSchema: { type: 'object', properties: { email: { type: 'string', format: 'email', title: 'Email' } }, required: ['email'] },
      }}
      onSubmit={onSubmit}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Please fill this in.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith('form-1', { email: 'ada@example.com' });
  });

  it('has every new card text in all shipped languages', () => {
    const keys: TranslationKey[] = [
      'chat.elicitation.fromServer', 'chat.elicitation.decline', 'chat.elicitation.urlTitle', 'chat.elicitation.urlOpen',
      'chat.elicitation.urlDone', 'chat.elicitation.urlLookalike', 'chat.elicitation.error.required',
    ];
    for (const { code } of SUPPORTED_LOCALES) {
      for (const key of keys) expect(translate(code, key, { server: 's', min: 1, max: 2 })).not.toBe(key);
    }
  });
});
