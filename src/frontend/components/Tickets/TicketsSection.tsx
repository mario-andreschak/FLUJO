'use client';
import { Badge, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import type { Ticket } from '@/shared/types/ticket';
import { ticketService } from '@/frontend/services/ticket';
import { AllTicketsDialog } from './AllTicketsDialog';
import { TicketCard } from './TicketCard';
export function TicketsSection() {
  const [items, setItems] = useState<Ticket[]>([]); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true); const [allOpen, setAllOpen] = useState(false);
  const load = useCallback(async () => { try { const page = await ticketService.listTickets({ status: 'open', limit: 3 }); setItems(page.items); setTotal(page.total); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); const refresh = () => void load(); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh); return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }; }, [load]);
  if (!loading && total === 0) return null;
  return <Box component="section" sx={{ mt: 3, mb: 3 }}><Stack spacing={1.5}><Stack direction="row" justifyContent="space-between" alignItems="center"><Badge badgeContent={total} color="primary"><Typography variant="h6" sx={{ pr: 1.5 }}>Agent messages</Typography></Badge><Button onClick={() => setAllOpen(true)}>View all ({total})</Button></Stack>{loading ? <CircularProgress size={22} /> : items.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} onDelete={(id) => void ticketService.deleteTicket(id).then(load)} />)}</Stack><AllTicketsDialog open={allOpen} onClose={() => setAllOpen(false)} onChanged={() => void load()} /></Box>;
}
