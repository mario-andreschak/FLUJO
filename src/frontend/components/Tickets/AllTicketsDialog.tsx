'use client';

import { DeleteOutlineRounded } from '@mui/icons-material';
import SearchIcon from '@mui/icons-material/Search';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputAdornment,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import { ticketService } from '@/frontend/services/ticket';
import { createLogger } from '@/utils/logger';
import type { Ticket, TicketStatus } from '@/shared/types/ticket';

import { TicketCard } from './TicketCard';

const log = createLogger('frontend/components/Tickets/AllTicketsDialog');

type StatusFilter = 'all' | TicketStatus;

export interface AllTicketsDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

/** Full ticket list with search, status/label filters, multi-select and bulk delete. */
export function AllTicketsDialog({ open, onClose, onChanged }: AllTicketsDialogProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await ticketService.listTickets({
        ...(status === 'all' ? {} : { status }),
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(label ? { label } : {}),
        limit: 100,
      });
      // Defensive: a degraded/stubbed API may answer without a usable `items`
      // array; the dialog must render empty rather than throw (#379).
      setItems(Array.isArray(page?.items) ? page.items : []);
      setError(null);
    } catch (loadError) {
      log.warn('Failed to load tickets', loadError);
      setItems([]);
      setError(t('tickets.toast.loadFailed'));
    }
  }, [label, search, status, t]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) {
      setSelected([]);
      setPendingDelete(null);
    }
  }, [open]);

  const labelOptions = useMemo(
    () => Array.from(new Set(items.flatMap((ticket) => (Array.isArray(ticket?.labels) ? ticket.labels : []))))
      .sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const confirmDelete = async () => {
    const ids = pendingDelete ?? [];
    setPendingDelete(null);
    if (!ids.length) return;
    try {
      await ticketService.deleteTickets(ids);
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      await load();
      onChanged();
    } catch (deleteError) {
      log.warn('Failed to delete tickets', deleteError);
      setError(t('tickets.toast.actionFailed'));
    }
  };

  const toggleStatus = async (ticket: Ticket) => {
    try {
      await ticketService.updateTicket(ticket.id, { status: ticket.status === 'done' ? 'open' : 'done' });
      await load();
      onChanged();
    } catch (updateError) {
      log.warn('Failed to update ticket', updateError);
      setError(t('tickets.toast.actionFailed'));
    }
  };

  const allSelected = items.length > 0 && selected.length === items.length;

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
        <DialogTitle>{t('tickets.dialog.title')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
            <Typography variant="caption" color="text.secondary">
              {t('tickets.untrustedHint')}
            </Typography>

            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
              <TextField
                size="small"
                sx={{ flex: 1 }}
                placeholder={t('tickets.search.placeholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                inputProps={{ 'aria-label': t('tickets.search.placeholder') }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
              <ToggleButtonGroup
                size="small"
                exclusive
                value={status}
                aria-label={t('tickets.filter.status')}
                onChange={(_event, value) => value && setStatus(value as StatusFilter)}
              >
                <ToggleButton value="all">{t('tickets.filter.all')}</ToggleButton>
                <ToggleButton value="open">{t('tickets.filter.open')}</ToggleButton>
                <ToggleButton value="done">{t('tickets.filter.done')}</ToggleButton>
              </ToggleButtonGroup>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <Select
                  displayEmpty
                  value={labelOptions.includes(label) ? label : ''}
                  onChange={(event) => setLabel(event.target.value)}
                  inputProps={{ 'aria-label': t('tickets.filter.label') }}
                >
                  <MenuItem value="">{t('tickets.filter.allLabels')}</MenuItem>
                  {labelOptions.map((option) => (
                    <MenuItem key={option} value={option}>{option}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>

            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={allSelected}
                    indeterminate={selected.length > 0 && !allSelected}
                    onChange={(event) => setSelected(event.target.checked ? items.map((ticket) => ticket.id) : [])}
                  />
                }
                label={t('tickets.bulk.selectAll')}
              />
              {selected.length > 0 && (
                <>
                  <Typography variant="body2" color="text.secondary">
                    {t('tickets.bulk.selected', { count: selected.length })}
                  </Typography>
                  <Button size="small" onClick={() => setSelected([])}>{t('tickets.bulk.clear')}</Button>
                </>
              )}
              <Button
                color="error"
                size="small"
                startIcon={<DeleteOutlineRounded />}
                disabled={!selected.length}
                onClick={() => setPendingDelete(selected)}
              >
                {t('tickets.bulk.deleteSelected')}
              </Button>
            </Stack>

            {items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t('tickets.dialog.empty')}</Typography>
            ) : (
              items.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  selectable
                  selected={selected.includes(ticket.id)}
                  onToggleSelect={(id) =>
                    setSelected((ids) => (ids.includes(id) ? ids.filter((current) => current !== id) : [...ids, id]))
                  }
                  onToggleStatus={(target) => void toggleStatus(target)}
                  onDelete={(id) => setPendingDelete([id])}
                />
              ))
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={pendingDelete !== null} onClose={() => setPendingDelete(null)}>
        <DialogTitle>{t('tickets.confirm.deleteTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('tickets.confirm.deleteBody', { count: pendingDelete?.length ?? 0 })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>{t('common.cancel')}</Button>
          <Button color="error" autoFocus onClick={() => void confirmDelete()}>
            {t('tickets.confirm.deleteAction')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default AllTicketsDialog;
