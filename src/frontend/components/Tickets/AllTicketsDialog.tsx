'use client';
import { DeleteOutlineRounded } from '@mui/icons-material';
import { Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, TextField } from '@mui/material';
import { useEffect, useState } from 'react';
import type { Ticket } from '@/shared/types/ticket';
import { ticketService } from '@/frontend/services/ticket';
import { TicketCard } from './TicketCard';
export function AllTicketsDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<Ticket[]>([]); const [selected, setSelected] = useState<string[]>([]); const [search, setSearch] = useState('');
  const load = () => ticketService.listTickets({ search, limit: 100 }).then((page) => setItems(page.items)).catch(() => setItems([]));
  useEffect(() => { if (open) void load(); }, [open, search]);
  const remove = async (ids: string[]) => { if (!ids.length || !confirm('Delete selected tickets? This cannot be undone.')) return; await ticketService.deleteTickets(ids); setSelected([]); await load(); onChanged(); };
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="md"><DialogTitle>All agent messages</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ pt: 1 }}><TextField label="Search tickets" size="small" value={search} onChange={(event) => setSearch(event.target.value)} /><Stack direction="row" gap={1}><FormControlLabel control={<Checkbox checked={items.length > 0 && selected.length === items.length} onChange={(event) => setSelected(event.target.checked ? items.map((ticket) => ticket.id) : [])} />} label="Select all" /><Button color="error" size="small" startIcon={<DeleteOutlineRounded />} disabled={!selected.length} onClick={() => void remove(selected)}>Delete selected</Button><Button color="error" size="small" onClick={() => void remove(items.map((ticket) => ticket.id))}>Delete all</Button></Stack>{items.map((ticket) => <Stack key={ticket.id} direction="row" gap={1} alignItems="flex-start"><Checkbox checked={selected.includes(ticket.id)} onChange={() => setSelected((ids) => ids.includes(ticket.id) ? ids.filter((id) => id !== ticket.id) : [...ids, ticket.id])} /><TicketCard ticket={ticket} onDelete={(id) => void remove([id])} /></Stack>)}</Stack></DialogContent><DialogActions><Button onClick={onClose}>Close</Button></DialogActions></Dialog>;
}
