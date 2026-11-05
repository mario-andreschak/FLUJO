'use client';

import { memo, useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Alert, Box, Button, IconButton, Pagination, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { DeleteOutlineRounded } from '@mui/icons-material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { MAX_COMPARISON_CASES } from '@/shared/types/harnessComparison';
import { emptyExampleRow, rowsFromJson, rowsFromPaste, rowsToCases, rowsToJson, type ExampleRow } from './comparisonDraft';
import { useDraftProblemText } from './useDraftProblemText';

const PAGE_SIZE = 25;
type Cell = 'input' | 'required' | 'forbidden' | 'expectedTools' | 'forbiddenTools' | 'toolResults';
const CELLS: readonly Cell[] = ['input', 'required', 'forbidden', 'expectedTools', 'forbiddenTools', 'toolResults'];
const CELL_LABELS = {
  input: 'harness.compare.input',
  required: 'harness.compare.required',
  forbidden: 'harness.compare.forbidden',
  expectedTools: 'harness.compare.expectedTools',
  forbiddenTools: 'harness.compare.forbiddenTools',
  toolResults: 'harness.compare.toolResults',
} as const;
const TABLE_COLUMNS = '32px minmax(0, 2.2fr) repeat(5, minmax(0, 1fr)) 36px';

/** Memoized on purpose: 200 examples must not all render again on each keystroke. */
const ExampleRowEditor = memo(function ExampleRowEditor({ row, number, table, disabled, onChange, onRemove }: {
  row: ExampleRow;
  number: number;
  table: boolean;
  disabled: boolean;
  onChange: (key: string, cell: Cell, value: string) => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useI18n();
  const remove = t('harness.compare.removeExample', { number });
  return (
    <Box
      data-testid="comparison-example-row"
      sx={table
        ? { display: 'grid', gridTemplateColumns: TABLE_COLUMNS, gap: 1, alignItems: 'start' }
        : { display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 2 }}
    >
      {table
        ? <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>{number}</Typography>
        : (
          <Stack direction="row" sx={{ gridColumn: '1 / -1', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="subtitle2">{number}</Typography>
            <Tooltip title={remove}><span><IconButton size="small" aria-label={remove} disabled={disabled} onClick={() => onRemove(row.key)}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip>
          </Stack>
        )}
      {CELLS.map((cell) => (
        <TextField
          key={cell}
          size="small"
          multiline
          maxRows={6}
          fullWidth
          disabled={disabled}
          value={row[cell]}
          onChange={(event) => onChange(row.key, cell, event.target.value)}
          {...(table
            ? { slotProps: { htmlInput: { 'aria-label': `${t(CELL_LABELS[cell])}, ${number}` } } }
            : { label: t(CELL_LABELS[cell]) })}
          sx={!table && cell === 'input' ? { gridColumn: '1 / -1' } : undefined}
        />
      ))}
      {table && (
        <Tooltip title={remove}><span><IconButton size="small" aria-label={remove} disabled={disabled} onClick={() => onRemove(row.key)} sx={{ mt: 0.25 }}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip>
      )}
    </Box>
  );
});

/**
 * The examples as a table or as JSON, one list either way. Broken JSON stays in its box
 * and blocks the start, so nothing half-written is run or lost by switching views.
 */
export default function ComparisonExamplesEditor({ rows, setRows, disabled, onJsonInvalid }: {
  rows: ExampleRow[];
  setRows: Dispatch<SetStateAction<ExampleRow[]>>;
  disabled: boolean;
  onJsonInvalid: (invalid: boolean) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const table = useMediaQuery(theme.breakpoints.up('lg'));
  const problemText = useDraftProblemText();
  const [view, setView] = useState<'table' | 'json'>('table');
  const [json, setJson] = useState('');
  const [jsonProblem, setJsonProblem] = useState('');
  const [page, setPage] = useState(1);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');

  useEffect(() => { onJsonInvalid(view === 'json' && !!jsonProblem); }, [jsonProblem, onJsonInvalid, view]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shownPage = Math.min(page, pages);
  const first = (shownPage - 1) * PAGE_SIZE;
  const filled = rowsToCases(rows).length;

  const changeCell = useCallback((key: string, cell: Cell, value: string) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, [cell]: value } : row));
  }, [setRows]);
  const removeRow = useCallback((key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  }, [setRows]);

  const changeJson = (text: string) => {
    setJson(text);
    const read = rowsFromJson(text);
    if (read.problem) { setJsonProblem(problemText(read.problem)); return; }
    setJsonProblem('');
    setRows(read.rows.length ? read.rows : [emptyExampleRow()]);
  };
  const addPasted = () => {
    const added = rowsFromPaste(pasted, t(CELL_LABELS.input));
    if (added.length === 0) return;
    // Rows nobody filled in make way, so pasting into a new form leaves no gap at the top.
    const next = [...rows.filter((row) => rowsToCases([row]).length > 0), ...added];
    setRows(next);
    setPage(Math.ceil(Math.max(1, next.length - added.length + 1) / PAGE_SIZE));
    setPasted('');
    setPasteOpen(false);
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h6" component="h3">{t('harness.examples')}</Typography>
          <Typography variant="body2" color={filled > MAX_COMPARISON_CASES ? 'error' : 'text.secondary'}>
            {t('harness.compare.count', { count: filled, max: MAX_COMPARISON_CASES })}
          </Typography>
        </Box>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={view}
          aria-label={t('harness.examples')}
          onChange={(_, next: 'table' | 'json' | null) => {
            if (!next || next === view) return;
            if (next === 'json') { setJson(rowsToJson(rows)); setJsonProblem(''); }
            setView(next);
          }}
        >
          <ToggleButton value="table" disabled={!!jsonProblem} sx={{ textTransform: 'none' }}>{t('harness.compare.viewTable')}</ToggleButton>
          <ToggleButton value="json" sx={{ textTransform: 'none' }}>{t('harness.compare.viewJson')}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Typography variant="body2" color="text.secondary">{t('harness.compare.examplesHelp')}</Typography>

      {view === 'json' ? (
        <TextField
          label={t('harness.compare.jsonLabel')}
          value={json}
          disabled={disabled}
          onChange={(event) => changeJson(event.target.value)}
          error={!!jsonProblem}
          helperText={jsonProblem || t('harness.compare.jsonHelp')}
          multiline
          minRows={10}
          maxRows={24}
          fullWidth
          slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
        />
      ) : (
        <>
          {table && (
            <Box sx={{ display: 'grid', gridTemplateColumns: TABLE_COLUMNS, gap: 1 }} aria-hidden>
              <span />
              {CELLS.map((cell) => <Typography key={cell} variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>{t(CELL_LABELS[cell])}</Typography>)}
              <span />
            </Box>
          )}
          <Stack spacing={1}>
            {rows.slice(first, first + PAGE_SIZE).map((row, index) => (
              <ExampleRowEditor key={row.key} row={row} number={first + index + 1} table={table} disabled={disabled} onChange={changeCell} onRemove={removeRow} />
            ))}
          </Stack>
          {pages > 1 && <Pagination count={pages} page={shownPage} size="small" onChange={(_, next) => setPage(next)} />}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button
              disabled={disabled || rows.length >= MAX_COMPARISON_CASES}
              onClick={() => { setRows((current) => [...current, emptyExampleRow()]); setPage(Math.ceil((rows.length + 1) / PAGE_SIZE)); }}
            >
              {t('harness.compare.addExample')}
            </Button>
            <Button disabled={disabled} onClick={() => setPasteOpen((open) => !open)} aria-expanded={pasteOpen}>{t('harness.compare.paste')}</Button>
          </Stack>
          {pasteOpen && (
            <Stack spacing={1}>
              <Alert severity="info">{t('harness.compare.pasteHelp')}</Alert>
              <TextField
                label={t('harness.compare.paste')}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                multiline
                minRows={4}
                maxRows={12}
                fullWidth
                slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
              />
              <Box><Button variant="outlined" disabled={!pasted.trim()} onClick={addPasted}>{t('harness.compare.addPasted')}</Button></Box>
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
