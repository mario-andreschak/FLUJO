'use client';

import MCPManager from '@/frontend/components/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/mcp/page');

export default function MCPPage() {
  log.debug('Rendering MCPPage');
  return (
    <main className="min-h-screen p-4">
      <MCPManager />
    </main>
  );
}
