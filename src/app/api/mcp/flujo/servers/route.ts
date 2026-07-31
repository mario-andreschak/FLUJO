import type { NextRequest } from 'next/server';
import { FLUJO_SERVER_TOOLS, handleFlujoToolRequest } from '@/backend/services/mcp/flujoControlApi';

export async function POST(request: NextRequest) {
  return handleFlujoToolRequest(request, FLUJO_SERVER_TOOLS);
}
