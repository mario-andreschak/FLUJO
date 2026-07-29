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

  it('offers a pre-filled GitHub fallback when the feedback service is unavailable', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'The feedback service is temporarily unavailable.' }),
    });
    const openMock = jest.spyOn(window, 'open').mockImplementation(() => null);
    render(<FeedbackBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'No, I am not happy' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Feedback' }), {
      target: { value: 'MCP installation needs a wizard.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open on GitHub' }));

    expect(openMock).toHaveBeenCalledTimes(1);
    const issueUrl = new URL(openMock.mock.calls[0][0] as string);
    expect(issueUrl.hostname).toBe('github.com');
    expect(issueUrl.searchParams.get('title')).toBe('FLUJO feedback');
    expect(issueUrl.searchParams.get('body')).toBe(
      'Sentiment: Not really\n\nMCP installation needs a wizard.',
    );
    openMock.mockRestore();
  });
});
