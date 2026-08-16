/**
 * "See all" ticket dialog (issue #379): search/filter, multi-select and the
 * confirmed bulk delete. Also pins the same defensive contract as the dashboard
 * section — a malformed list payload must render an empty dialog, not throw.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const listTickets = jest.fn();
const deleteTickets = jest.fn();
const updateTicket = jest.fn();

jest.mock('@/frontend/services/ticket', () => ({
  ticketService: {
    listTickets: (...args: unknown[]) => listTickets(...args),
    deleteTickets: (...args: unknown[]) => deleteTickets(...args),
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

import { AllTicketsDialog } from '@/frontend/components/Tickets/AllTicketsDialog';

const tickets = [
  { id: 'a', message: 'restart the worker', labels: ['ops'], status: 'open', createdAt: 2, updatedAt: 2 },
  { id: 'b', message: 'polish the header', labels: ['ux'], status: 'done', createdAt: 1, updatedAt: 1 },
];

beforeEach(() => {
  jest.clearAllMocks();
  listTickets.mockResolvedValue({ items: tickets, total: 2, hasMore: false });
  deleteTickets.mockResolvedValue({ deleted: 2, errors: 0 });
});

describe('AllTicketsDialog', () => {
  it('loads the full list when opened', async () => {
    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('restart the worker')).toBeInTheDocument());
    expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('does not query while closed', () => {
    render(<AllTicketsDialog open={false} onClose={jest.fn()} onChanged={jest.fn()} />);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('re-queries the backend with the search term', async () => {
    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={jest.fn()} />);
    await waitFor(() => expect(listTickets).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('tickets.search.placeholder'), { target: { value: 'header' } });

    await waitFor(() =>
      expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ search: 'header' })));
  });

  it('re-queries with the status filter', async () => {
    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={jest.fn()} />);
    await waitFor(() => expect(listTickets).toHaveBeenCalled());

    fireEvent.click(screen.getByText('tickets.filter.done'));

    await waitFor(() => expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' })));
  });

  it('bulk-deletes the selected tickets after confirmation', async () => {
    const onChanged = jest.fn();
    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText('restart the worker')).toBeInTheDocument());

    const checkboxes = screen.getAllByLabelText('tickets.action.select');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    fireEvent.click(screen.getByText('tickets.bulk.deleteSelected'));
    fireEvent.click(screen.getByText('tickets.confirm.deleteAction'));

    await waitFor(() => expect(deleteTickets).toHaveBeenCalledWith(['a', 'b']));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('keeps the bulk delete disabled until something is selected', async () => {
    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('restart the worker')).toBeInTheDocument());

    expect(screen.getByText('tickets.bulk.deleteSelected').closest('button')).toBeDisabled();

    fireEvent.click(screen.getAllByLabelText('tickets.action.select')[0]);
    expect(screen.getByText('tickets.bulk.deleteSelected').closest('button')).not.toBeDisabled();
  });

  it('renders empty instead of throwing on a malformed payload', async () => {
    listTickets.mockResolvedValue({});

    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('tickets.dialog.empty')).toBeInTheDocument());
  });

  it('reports a failed load without wiping out the dialog', async () => {
    listTickets.mockRejectedValue(new Error('boom'));

    render(<AllTicketsDialog open onClose={jest.fn()} onChanged={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('tickets.toast.loadFailed')).toBeInTheDocument());
  });
});
