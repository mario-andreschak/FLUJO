'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import type { FactoryObservatorySnapshot } from '@/backend/services/factory/observatorySnapshot';

const POLL_MS = 30_000;

function treeOrder(cells: FactoryObservatorySnapshot['cells']) {
  const children = new Map<string, typeof cells>();
  for (const cell of cells) {
    if (cell.parentId === null) continue;
    const siblings = children.get(cell.parentId) ?? [];
    siblings.push(cell);
    children.set(cell.parentId, siblings);
  }
  const ordered: typeof cells = [];
  const pending = [...(cells.filter((cell) => cell.parentId === null))];
  while (pending.length) {
    const cell = pending.pop()!;
    ordered.push(cell);
    pending.push(...(children.get(cell.id) ?? []).sort((a, b) => b.id.localeCompare(a.id)));
  }
  return ordered;
}

export default function FactoryObservatoryPanel() {
  const [snapshot, setSnapshot] = useState<FactoryObservatorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/factory-observatory', { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error === 'FACTORY_NOT_CONFIGURED' ? 'FACTORY is not configured for this FLUJO instance.'
          : 'FACTORY is unavailable.');
      }
      setSnapshot(await response.json() as FactoryObservatorySnapshot);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'FACTORY is unavailable.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const cells = useMemo(() => treeOrder(snapshot?.cells ?? []), [snapshot]);
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of snapshot?.tasks ?? []) if (task.owner) counts.set(task.owner, (counts.get(task.owner) ?? 0) + 1);
    return counts;
  }, [snapshot]);

  return (
    <Paper variant="outlined" data-testid="factory-observatory" sx={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 4, p: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" mb={1}>
        <Typography variant="h6">FACTORY swarm</Typography>
        {snapshot && <Chip size="small" label={snapshot.factoryId} />}
        {snapshot && <Chip size="small" color={snapshot.status === 'paused' ? 'warning' : 'success'} label={snapshot.status} />}
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={() => { void refresh(); }}>Refresh</Button>
      </Stack>
      {error && <Alert severity="warning" sx={{ mb: 1 }}>{error}{snapshot ? ' Showing the last received snapshot.' : ''}</Alert>}
      {!snapshot && !error && <Typography color="text.secondary">Connecting to FACTORY…</Typography>}
      {snapshot && (
        <>
          <Typography variant="body2" color="text.secondary" mb={1}>
            {snapshot.mission} · {snapshot.cells.length} {snapshot.cells.length === 1 ? 'cell' : 'cells'} · {snapshot.tasks.length} {snapshot.tasks.length === 1 ? 'task' : 'tasks'} · {snapshot.unresolvedEffects} unresolved effects
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" mb={1}>
            Observed {new Date(snapshot.observedAt).toLocaleString()} · revision {snapshot.revision} · read only
          </Typography>
          <Stack spacing={0.75}>
            {cells.map((cell) => (
              <Paper key={cell.id} variant="outlined" sx={{ ml: Math.min(cell.depth, 12) * 2, px: 1.5, py: 0.75 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="body2" fontWeight={700}>{cell.id}</Typography>
                  <Chip size="small" variant="outlined" label={cell.role} />
                  <Chip size="small" color={cell.status === 'ready' ? 'success' : 'default'} label={cell.status} />
                  {(taskCounts.get(cell.id) ?? 0) > 0 && <Chip size="small" label={`${taskCounts.get(cell.id)} ${taskCounts.get(cell.id) === 1 ? 'task' : 'tasks'}`} />}
                  <Typography variant="caption" color="text.secondary">{cell.purpose}</Typography>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </>
      )}
    </Paper>
  );
}
