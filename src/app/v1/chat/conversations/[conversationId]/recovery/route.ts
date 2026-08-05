import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  getSubflowRecoveryOptions,
  retrySubflowRecoveryScope,
  type SubflowRecoveryScope,
} from '@/backend/execution/flow/subflowRecovery';

const SCOPES = new Set<SubflowRecoveryScope>(['branch', 'siblings', 'deepest']);

async function guard(request: NextRequest): Promise<NextResponse | null> {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return assertLocalRequest(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const denied = await guard(request);
  if (denied) return denied;
  const { conversationId } = await params;
  try {
    return NextResponse.json(await getSubflowRecoveryOptions(conversationId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const denied = await guard(request);
  if (denied) return denied;
  const { conversationId } = await params;
  let scope: SubflowRecoveryScope;
  try {
    const body = await request.json() as { scope?: unknown };
    if (typeof body.scope !== 'string' || !SCOPES.has(body.scope as SubflowRecoveryScope)) {
      return NextResponse.json({ error: 'scope must be branch, siblings, or deepest' }, { status: 400 });
    }
    scope = body.scope as SubflowRecoveryScope;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const result = await retrySubflowRecoveryScope(conversationId, scope);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /already running|no recoverable/i.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
