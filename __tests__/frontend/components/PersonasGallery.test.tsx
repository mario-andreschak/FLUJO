/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const loadPageMock = jest.fn();
jest.mock('@/frontend/components/Personas/personaQueries', () => ({
  loadPersonaSummaryPage: (...args: unknown[]) => loadPageMock(...args),
  invalidatePersonaSummaryCache: jest.fn(),
}));
jest.mock('@/frontend/components/Personas/PersonaSummaryCard', () => ({
  __esModule: true,
  default: ({ summary }: { summary: { name: string } }) => <div>{summary.name}</div>,
}));

import PersonasGallery from '@/frontend/components/Personas/PersonasGallery';

const cards = (start: number, end: number, suffix = '') => Array.from({ length: end - start }, (_, index) => ({
  id: `persona_${index + start}`, name: `Persona ${index + start}${suffix}`,
}));

beforeEach(() => { jest.clearAllMocks(); });

it('refreshes externally changed statuses without dropping cards from already loaded pages', async () => {
  loadPageMock.mockResolvedValueOnce({ items: cards(0, 24), nextCursor: 'page_2', hasMore: true });
  loadPageMock.mockResolvedValueOnce({ items: cards(24, 48), nextCursor: null, hasMore: false });
  loadPageMock.mockResolvedValueOnce({ items: cards(0, 48, ' working'), nextCursor: null, hasMore: false });
  render(<PersonasGallery busy={false} onCreate={() => {}} onTalk={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Persona 47')).toBeInTheDocument();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('Persona 47 working')).toBeInTheDocument();
  expect(screen.getByText('Persona 0 working')).toBeInTheDocument();
  expect(loadPageMock).toHaveBeenLastCalledWith(expect.objectContaining({ pageSize: 48, force: true }));
});

it('lets a slow background refresh finish instead of aborting it on another focus event', async () => {
  let finish!: (value: unknown) => void;
  loadPageMock.mockResolvedValueOnce({ items: cards(0, 1), nextCursor: null, hasMore: false });
  loadPageMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<PersonasGallery busy={false} onCreate={() => {}} onTalk={async () => {}} />);
  expect(await screen.findByText('Persona 0')).toBeInTheDocument();
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(loadPageMock).toHaveBeenCalledTimes(2));
  const signal = loadPageMock.mock.calls[1][0].signal as AbortSignal;
  fireEvent(window, new Event('focus'));
  expect(loadPageMock).toHaveBeenCalledTimes(2);
  expect(signal.aborted).toBe(false);
  await act(async () => { finish({ items: cards(0, 1, ' working'), nextCursor: null, hasMore: false }); });
  expect(await screen.findByText('Persona 0 working')).toBeInTheDocument();
});
