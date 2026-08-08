import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { mcpService } from '@/backend/services/mcp';
import {
  getMcpAppConsent,
  setMcpAppConsent,
  type McpAppConsentDecision,
} from '@/backend/mcpApps/appConsent';

function input(request: NextRequest) {
  const serverName = request.nextUrl.searchParams.get('serverName')?.trim();
  const uri = request.nextUrl.searchParams.get('uri')?.trim();
  const conversationId = request.nextUrl.searchParams.get('conversationId')?.trim();
  return { serverName, uri, conversationId };
}

async function serverConfig(serverName: string) {
  const configs = await mcpService.loadServerConfigs();
  return Array.isArray(configs) ? configs.find((config) => config.name === serverName) : undefined;
}

export async function GET(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const { serverName, uri, conversationId } = input(request);
  if (!serverName || !uri) {
    return NextResponse.json({ error: 'Invalid MCP App identity' }, { status: 400 });
  }
  const status = await getMcpAppConsent(await serverConfig(serverName), serverName, uri, conversationId);
  return NextResponse.json({ status }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked();
  if (lock) return lock;
  const body = await request.json() as {
    serverName?: unknown; uri?: unknown; conversationId?: unknown; decision?: unknown;
  };
  if (
    typeof body.serverName !== 'string' || !body.serverName.trim()
    || typeof body.uri !== 'string' || !body.uri.trim()
    || !['allow-once', 'allow-always', 'deny-always'].includes(String(body.decision))
  ) {
    return NextResponse.json({ error: 'Invalid MCP App consent decision' }, { status: 400 });
  }
  await setMcpAppConsent(
    body.serverName.trim(),
    body.uri.trim(),
    body.decision as McpAppConsentDecision,
    typeof body.conversationId === 'string' ? body.conversationId : undefined,
  );
  const status = await getMcpAppConsent(
    await serverConfig(body.serverName.trim()),
    body.serverName.trim(),
    body.uri.trim(),
    typeof body.conversationId === 'string' ? body.conversationId : undefined,
  );
  return NextResponse.json({ status }, { headers: { 'Cache-Control': 'no-store' } });
}
