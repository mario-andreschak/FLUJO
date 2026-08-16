import { withWorkspaceRoute } from '@/app/api/_workspace';
import type { NextRequest } from 'next/server';
import { FLUJO_FLOW_TOOLS, handleFlujoToolRequest } from '@/backend/services/mcp/flujoControlApi';
import { assertUnlocked } from '@/utils/encryption/lockGate';

async function POST_handler(request: NextRequest) {
  // #77 deny-by-default encryption gate (also called in handleFlujoToolRequest).
  const locked = await assertUnlocked();
  if (locked) return locked;

  return handleFlujoToolRequest(request, FLUJO_FLOW_TOOLS);
}

export const POST = withWorkspaceRoute(POST_handler);
