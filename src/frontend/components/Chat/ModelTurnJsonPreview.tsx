'use client';

import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { modelTurnJsonPage } from './modelTurnJsonPage';

export default function ModelTurnJsonPreview({ value, testId }: { value: unknown; testId?: string }) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [value]);
  const current = useMemo(() => modelTurnJsonPage(value, page), [value, page]);
  return (
    <>
      <Box component="pre" data-testid={testId} sx={{
        m: 0, p: 1.5, maxHeight: '55vh', overflow: 'auto', whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere', fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12, lineHeight: 1.55, bgcolor: 'action.hover',
      }}>{current.text}</Box>
      {(page > 0 || current.hasNext) && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5 }}>
          <Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous text page</Button>
          <Typography variant="caption">Page {page + 1}</Typography>
          <Button disabled={!current.hasNext} onClick={() => setPage(value => value + 1)}>Next text page</Button>
        </Box>
      )}
    </>
  );
}
