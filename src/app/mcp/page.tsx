import { Box } from '@mui/material';
import { headers } from 'next/headers';
import MCPManager from '@/frontend/components/mcp';

export const dynamic = 'force-dynamic';

export default async function MCPPage() {
  const controllerAccount = (await headers()).get('x-flujo-controller-account') === '1';
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <MCPManager controllerAccount={controllerAccount} />
    </Box>
  );
}
