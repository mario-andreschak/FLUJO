'use client';

import { Alert, Badge, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import { ticketService } from '@/frontend/services/ticket';
import { createLogger } from '@/utils/logger';
import type { Ticket } from '@/shared/types/ticket';

import { AllTicketsDialog } from './AllTicketsDialog';
import { TicketCard } from './TicketCard';

const log = createLogger('frontend/components/Tickets/TicketsSection');

/** How many cards the dashboard shows before the "See all" dialog takes over. */
const DASHBOARD_TICKET_LIMIT = 4;

/** Dashboard section listing the newest open agent tickets (issue #379). */
export function TicketsSection() {
  const { t } = useI18n();
  const [items, setItems] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [allOpen, setAllOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await ticketService.listTickets({ status: 'open', limit: DASHBOARD_TICKET_LIMIT });
      // The service normalises the payload, but the dashboard must survive a
      // stubbed/degraded API too: never let `items`/`total` become undefined,
      // otherwise the whole home page crashes on `items.map` (#379).
      const list = Array.isArray(page?.items) ? page.items : [];
      setItems(list);
      setTotal(typeof page?.total === 'number' && Number.isFinite(page.total) ? page.total : list.length);
      setError(null);
    } catch (loadError) {
      log.warn('Failed to load tickets', loadError);
      setItems([]);
      setTotal(0);
      setError(t('tickets.toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const removeTicket = async (id: string) => {
    try {
      await ticketService.deleteTicket(id);
      await load();
    } catch (deleteError) {
      log.warn('Failed to delete ticket', deleteError);
      setError(t('tickets.toast.actionFailed'));
    }
  };

  const markDone = async (ticket: Ticket) => {
    try {
      await ticketService.updateTicket(ticket.id, { status: ticket.status === 'done' ? 'open' : 'done' });
      await load();
    } catch (updateError) {
      log.warn('Failed to update ticket', updateError);
      setError(t('tickets.toast.actionFailed'));
    }
  };

  // Keep the dashboard quiet when there is nothing to hand back to the human.
  if (!loading && total === 0 && !error) return null;

  return (
    <Box component="section" sx={{ mt: 3, mb: 3 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box>
            <Badge badgeContent={total} color="primary">
              <Typography variant="h6" sx={{ pr: 1.5 }}>{t('tickets.section.title')}</Typography>
            </Badge>
            <Typography variant="body2" color="text.secondary">{t('tickets.section.subtitle')}</Typography>
          </Box>
          <Button onClick={() => setAllOpen(true)}>{t('tickets.section.seeAll', { count: total })}</Button>
        </Stack>

        {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}

        {loading ? (
          <CircularProgress size={22} />
        ) : items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">{t('tickets.section.empty')}</Typography>
        ) : (
          items.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              onDelete={(id) => void removeTicket(id)}
              onToggleStatus={(target) => void markDone(target)}
            />
          ))
        )}
      </Stack>

      <AllTicketsDialog open={allOpen} onClose={() => setAllOpen(false)} onChanged={() => void load()} />
    </Box>
  );
}

export default TicketsSection;
