'use client';

import { Box } from '@mui/material';
import Statistics from '@/frontend/components/Statistics';

/** Analytics dashboard. */
export default function StatisticsPage() {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Statistics />
    </Box>
  );
}
