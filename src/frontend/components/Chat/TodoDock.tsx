'use client';

import React from 'react';
import { Box, Paper, Typography, LinearProgress } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import CancelIcon from '@mui/icons-material/Cancel';
import type { TodoEventItem } from '@/shared/types/execution/events';
import { useI18n } from '@/frontend/contexts/I18nContext';

/**
 * TodoDock (issue #259): a compact live checklist rendered from the run-scoped
 * `todo` list a model maintains via the synthetic `todo` tool. Purely
 * presentational — the parent (Chat) owns the `todos` state, rebuilt from the
 * `todo:update` SSE stream. Renders nothing when the list is empty.
 */
export interface TodoDockProps {
  todos: TodoEventItem[];
}

function statusIcon(status: TodoEventItem['status']) {
  switch (status) {
    case 'done':
      return <CheckCircleIcon fontSize="small" color="success" />;
    case 'in_progress':
      return <AutorenewIcon fontSize="small" color="info" />;
    case 'cancelled':
      return <CancelIcon fontSize="small" color="disabled" />;
    default:
      return <RadioButtonUncheckedIcon fontSize="small" color="disabled" />;
  }
}

const TodoDock: React.FC<TodoDockProps> = ({ todos }) => {
  const { t, formatNumber } = useI18n();
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'done').length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;

  return (
    <Paper variant="outlined" sx={{ mt: 2, p: 1.5, borderRadius: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {t('chat.todo.title')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t('chat.todo.progress', { done: formatNumber(done), total: formatNumber(todos.length) })}
        </Typography>
      </Box>
      <LinearProgress variant="determinate" value={pct} sx={{ mb: 1, borderRadius: 1 }} />
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {todos.map((t) => (
          <Box
            component="li"
            key={t.id}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}
          >
            {statusIcon(t.status)}
            <Typography
              variant="body2"
              sx={{
                textDecoration:
                  t.status === 'done' || t.status === 'cancelled' ? 'line-through' : 'none',
                color:
                  t.status === 'done' || t.status === 'cancelled'
                    ? 'text.secondary'
                    : 'text.primary',
              }}
            >
              {t.content}
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
};

export default TodoDock;
