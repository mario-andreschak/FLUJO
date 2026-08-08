import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * POST /api/packages/scan-targets (issue #285).
 *
 * Backend for the package wizard's "Add a secret manually" VALUE PICKER: return
 * the flat list of pickable candidate strings already present in the packaged
 * content (flow descriptions/node properties, model display/connection/prompt
 * fields, planned-execution prompts) so the user can visually pick a value to
 * redact instead of retyping it.
 *
 * SECURITY: reuses the exact same content extractor (`extractScanTargets` via
 * `scanTargetsForSelection`) that secret derivation uses. That extractor is the
 * choke-point that NEVER emits model API keys or MCP env/header VALUES — only
 * plaintext already in config. No secret value ever leaves the manifest path.
 *
 * Guarded fail-closed with `assertUnlocked` then `assertLocalRequest`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  scanTargetsForSelection,
  type PackageSelection,
} from '@/backend/services/packages/buildPackage';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/scan-targets/route');

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

async function POST_handler(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const selectionRaw = (raw.selection ?? raw) as Record<string, unknown>;
  const selection: PackageSelection = {
    flowIds: sanitizeStringArray(selectionRaw.flowIds),
    modelIds: sanitizeStringArray(selectionRaw.modelIds),
    mcpServerNames: sanitizeStringArray(selectionRaw.mcpServerNames),
    plannedExecutionIds: sanitizeStringArray(selectionRaw.plannedExecutionIds),
  };

  try {
    const candidates = await scanTargetsForSelection(selection);
    return NextResponse.json({ candidates });
  } catch (err) {
    log.error('Failed to enumerate package scan targets', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to enumerate scan targets' },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
