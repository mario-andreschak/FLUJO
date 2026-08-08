/**
 * Dashboard tickets section (issue #379).
 *
 * Regression focus: the section renders on the app's home page, so ANY runtime
 * throw here takes the whole dashboard down (and took the HomeSetupJourney
 * suite with it, because its generic `fetch` stub answers `{}` for every
 * request). The list payload must therefore be treated as untrusted at runtime:
 * `items` defaults to `[]`, `total` to the item count, and a malformed ticket
 * record must render instead of throwing.
 */
import { render, screen, waitFor } from '@testing-library/react';

const listTickets = jest.fn();
const deleteTicket = jest.fn();
const updateTicket = jest.fn();

jest.mock('@/frontend/services/ticket', () => ({
  ticketService: {
    listTickets: (...args: unknown[]) => listTickets(...args),
    deleteTicket: (...args: unknown[]) => deleteTicket(...args),
    updateTicket: (...args: unknown[]) => updateTicket(...args),
  },
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { TicketsSection } from '@/frontend/components/Tickets/TicketsSection';

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 'ticket-1',
  message: 'Please review the deploy',
  labels: ['ops'],
  status: 'open',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TicketsSection', () => {
  it('asks for only the dashboard-sized slice of open tickets', async () => {
    listTickets.mockResolvedValue({ items: [ticket()], total: 1, hasMore: false });

    render(<TicketsSection />);

    await waitFor(() => expect(screen.getByText('Please review the deploy')).toBeInTheDocument());
    expect(listTickets).toHaveBeenCalledWith({ status: 'open', limit: 4 });
    expect(screen.getByText('tickets.section.title')).toBeInTheDocument();
  });

  it('renders nothing once it knows there are no tickets', async () => {
    listTickets.mockResolvedValue({ items: [], total: 0, hasMore: false });

    const { container } = render(<TicketsSection />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it.each([
    ['an undefined body', undefined],
    ['an empty object', {}],
    ['a null items field', { items: null, total: 3 }],
    ['a non-array items field', { items: 'nope', total: 'many' }],
  ])('tolerates a malformed list payload: %s', async (_label, payload) => {
    listTickets.mockResolvedValue(payload);

    const { container } = render(<TicketsSection />);

    // No throw, no crash of the surrounding dashboard.
    await waitFor(() => expect(listTickets).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).not.toContain('tickets.toast.loadFailed'));
  });

  it('renders a ticket that is missing its labels array', async () => {
    listTickets.mockResolvedValue({ items: [{ id: 'ticket-2', message: 'no labels here', status: 'open' }], total: 1 });

    render(<TicketsSection />);

    await waitFor(() => expect(screen.getByText('no labels here')).toBeInTheDocument());
  });

  it('shows a localized error and no stale list when loading fails', async () => {
    listTickets.mockRejectedValue(new Error('boom'));

    render(<TicketsSection />);

    await waitFor(() => expect(screen.getByText('tickets.toast.loadFailed')).toBeInTheDocument());
  });
});
