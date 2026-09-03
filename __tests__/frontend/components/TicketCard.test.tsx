/**
 * Ticket card (issue #379).
 *
 * Ticket text is agent-authored, so the card renders it as plain text, shows
 * one pill per label, only offers navigation actions for the provenance it
 * actually has, and must not throw on a malformed record.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = jest.fn();
const mockCollectBugReportContext = jest.fn();
const mockOpenGitHubNewIssue = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => push(...args) }),
}));

jest.mock('@/frontend/utils/bugReportContext', () => ({
  collectBugReportContext: () => mockCollectBugReportContext(),
  buildBugReportContext: () => ({
    appVersion: 'unknown',
    installMode: 'unknown',
    os: 'unknown',
    browser: 'unknown',
    pageUrl: 'unknown',
    timestamp: '2026-09-03T00:00:00.000Z',
  }),
}));

jest.mock('@/frontend/utils/openGitHubIssue', () => ({
  openGitHubNewIssue: (...args: unknown[]) => mockOpenGitHubNewIssue(...args),
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { TicketCard } from '@/frontend/components/Tickets/TicketCard';
import { ticketDraftStorageKey } from '@/frontend/utils/workspaceContentKeys';
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
  mockCollectBugReportContext.mockResolvedValue({
    appVersion: '3.45.0',
    installMode: 'git',
    os: 'Windows',
    browser: 'Chrome',
    pageUrl: '/dashboard',
    timestamp: '2026-09-03T20:12:03.231Z',
  });
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

  it('opens a GitHub issue draft with ticket data and safe context', async () => {
    render(
      <TicketCard
        ticket={ticket({
          title: 'Deploy failed',
          conversationId: 'conv-1',
          messageId: 'message-1',
          flowId: 'flow-1',
          nodeId: 'node-1',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'tickets.action.reportBug' }));

    await waitFor(() => expect(mockOpenGitHubNewIssue).toHaveBeenCalledTimes(1));
    expect(mockCollectBugReportContext).toHaveBeenCalledTimes(1);
    const draft = mockOpenGitHubNewIssue.mock.calls[0][0] as {
      title: string;
      body: string;
      labels: string[];
    };
    expect(draft.title).toBe('Deploy failed');
    expect(draft.labels).toEqual(['bug']);
    expect(draft.body).toContain('    Please review the deploy');
    expect(draft.body).toContain('#### Conversation ID\n\n    conv-1');
    expect(draft.body).toContain('#### Message ID\n\n    message-1');
    expect(draft.body).toContain('#### Flow ID\n\n    flow-1');
    expect(draft.body).toContain('#### Node ID\n\n    node-1');
    expect(draft.body).toContain('App version: 3.45.0');
    expect(push).not.toHaveBeenCalled();
  });

  it('reports without optional provenance when context collection fails', async () => {
    mockCollectBugReportContext.mockRejectedValueOnce(new Error('context unavailable'));
    render(<TicketCard ticket={ticket()} />);

    fireEvent.click(screen.getByRole('button', { name: 'tickets.action.reportBug' }));

    await waitFor(() => expect(mockOpenGitHubNewIssue).toHaveBeenCalledTimes(1));
    const draft = mockOpenGitHubNewIssue.mock.calls[0][0] as {
      title: string;
      body: string;
    };
    expect(draft.title).toBe('Ticket report');
    expect(draft.body).toContain('    Please review the deploy');
    expect(draft.body).toContain('App version: unknown');
    expect(draft.body).not.toContain('#### Conversation ID');
    expect(draft.body).not.toContain('#### Flow ID');
    expect(push).not.toHaveBeenCalled();
  });

  it('hands the composer a delimited, untrusted draft for Ask FLUJO', () => {
    render(<TicketCard ticket={ticket()} />);

    fireEvent.click(screen.getByText('tickets.action.askFlujo'));

    const draft = sessionStorage.getItem(ticketDraftStorageKey()) ?? '';
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
    expect(sessionStorage.getItem(ticketDraftStorageKey())).not.toContain('Labels:');
  });
});
