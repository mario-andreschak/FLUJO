'use client';

import { Box } from '@mui/material';
import PackagesManager from '@/frontend/components/Packages';

/** Packages page (issue #194). */
export default function PackagesPage() {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PackagesManager />
    </Box>
  );
}
