import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { hasExecutionExtensionContext } from '@/backend/execution/extensions';
import { workspaceAllowance, refreshWorkspaceAllowance } from '@/backend/services/model/allowance';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

async function response(request: NextRequest, refresh: boolean) {
  const local = assertLocalRequest(request); if (local) return local;
  const locked = await assertUnlocked(); if (locked) return locked;
  if (hasExecutionExtensionContext()) return NextResponse.json({ error: 'allowance_unavailable' }, { status: 403, headers });
  try {
    const snapshot = refresh ? await refreshWorkspaceAllowance(request.signal) : await workspaceAllowance();
    return NextResponse.json(snapshot, { headers });
  } catch {
    // Native stderr and account details must never become HTTP error payloads.
    return NextResponse.json({ error: 'allowance_unavailable' }, { status: 503, headers });
  }
}

export const GET = withWorkspaceRoute((request: NextRequest) => response(request, false));
export const POST = withWorkspaceRoute((request: NextRequest) => response(request, true));
