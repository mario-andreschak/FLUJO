import type { NextRequest } from 'next/server';
import { FLUJO_STATE_TOOLS, handleFlujoToolRequest } from '@/backend/services/mcp/flujoControlApi';

export async function POST(request: NextRequest) {
  return handleFlujoToolRequest(request, FLUJO_STATE_TOOLS);
}
