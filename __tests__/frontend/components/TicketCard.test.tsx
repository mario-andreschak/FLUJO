/**
 * Ticket card (issue #379).
 *
 * Ticket text is agent-authored, so the card renders it as plain text, shows
 * one pill per label, only offers navigation actions for the provenance it
 * actually has, and must not throw on a malformed record.
 */
import { fireEvent, render, screen } from '@testing-library/react';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => push(...args) }),
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { TicketCard } from '@/frontend/components/Tickets/TicketCard';
import { TICKET_DRAFT_STORAGE_KEY } from '@/shared/types/ticket';
import type { Ticket } from '@/shared/types/ticket';

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1',
  message: 'Please review the deploy',
  labels: ['ops', 'review'],
  status: 'open',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('TicketCard', () => {
  it('renders the message and one pill per label', () => {
    render(<TicketCard ticket={ticket({ title: 'Deploy' })} />);

    expect(screen.getByText('Deploy')).toBeInTheDocument();
    expect(screen.getByText('Please review the deploy')).toBeInTheDocument();
    expect(screen.getByText('ops')).toBeInTheDocument();
    expect(screen.getByText('review')).toBeInTheDocument();
  });

  it('renders agent text verbatim instead of interpreting it as markup', () => {
    render(<TicketCard ticket={ticket({ message: '<b>not bold</b>' })} />);

    expect(screen.getByText('<b>not bold</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('hides the conversation and flow actions when that provenance is missing', () => {
    render(<TicketCard ticket={ticket()} />);

    expect(screen.queryByText('tickets.action.openConversation')).not.toBeInTheDocument();
    expect(screen.queryByText('tickets.action.openFlow')).not.toBeInTheDocument();
  });

  it('navigates to the linked conversation and flow when present', () => {
    render(<TicketCard ticket={ticket({ conversationId: 'conv-1', flowId: 'flow-1' })} />);

    fireEvent.click(screen.getByText('tickets.action.openConversation'));
    expect(push).toHaveBeenCalledWith(expect.stringContaining('conv-1'));

    fireEvent.click(screen.getByText('tickets.action.openFlow'));
    expect(push).toHaveBeenCalledWith(expect.stringContaining('flow-1'));
  });

  it('hands the composer a delimited, untrusted draft for Ask FLUJO', () => {
    render(<TicketCard ticket={ticket()} />);

    fireEvent.click(screen.getByText('tickets.action.askFlujo'));

    const draft = sessionStorage.getItem(TICKET_DRAFT_STORAGE_KEY) ?? '';
    expect(draft).toContain('--- BEGIN TICKET ---');
    expect(draft).toContain('Please review the deploy');
    expect(draft).toContain('Labels: ops, review');
    expect(push).toHaveBeenCalledWith('/chat');
  });

  it('fires delete, status toggle and selection callbacks', () => {
    const onDelete = jest.fn();
    const onToggleStatus = jest.fn();
    const onToggleSelect = jest.fn();

    render(
      <TicketCard
        ticket={ticket()}
        selectable
        selected={false}
        onDelete={onDelete}
        onToggleStatus={onToggleStatus}
        onToggleSelect={onToggleSelect}
      />,
    );

    fireEvent.click(screen.getByLabelText('tickets.action.select'));
    expect(onToggleSelect).toHaveBeenCalledWith('ticket-1');

    fireEvent.click(screen.getByLabelText('tickets.action.markDone'));
    expect(onToggleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'ticket-1' }));

    fireEvent.click(screen.getByLabelText('tickets.action.delete'));
    expect(onDelete).toHaveBeenCalledWith('ticket-1');
  });

  it('offers reopen instead of mark-done for a completed ticket', () => {
    render(<TicketCard ticket={ticket({ status: 'done' })} onToggleStatus={jest.fn()} />);

    expect(screen.getByLabelText('tickets.action.reopen')).toBeInTheDocument();
    expect(screen.queryByLabelText('tickets.action.markDone')).not.toBeInTheDocument();
  });

  it('survives a malformed record whose labels are missing', () => {
    const malformed = { id: 'ticket-2', message: 'no labels', status: 'open', createdAt: 0, updatedAt: 0 } as unknown as Ticket;

    expect(() => render(<TicketCard ticket={malformed} />)).not.toThrow();
    expect(screen.getByText('no labels')).toBeInTheDocument();

    fireEvent.click(screen.getByText('tickets.action.askFlujo'));
    expect(sessionStorage.getItem(TICKET_DRAFT_STORAGE_KEY)).not.toContain('Labels:');
  });
});
