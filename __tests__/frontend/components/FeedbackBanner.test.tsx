import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FeedbackBanner from '@/frontend/components/FeedbackBanner';

describe('FeedbackBanner', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
  });

  it('submits happy feedback and shows a thank-you message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    });
    render(<FeedbackBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Yes, I am happy' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Feedback' }), {
      target: { value: 'The flow builder is great.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/registry/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notice: 'The flow builder is great.',
        rating: 5,
      }),
    });
    expect(await screen.findByText('Thanks for helping improve FLUJO.')).toBeInTheDocument();
  });

  it('maps unhappy feedback to a 1 rating', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    });
    render(<FeedbackBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'No, I am not happy' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Feedback' }), {
      target: { value: 'Setup was confusing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      notice: 'Setup was confusing.',
      rating: 1,
    });
  });

  it('requires both a sentiment and non-empty feedback', () => {
    render(<FeedbackBanner />);

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I am happy' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
