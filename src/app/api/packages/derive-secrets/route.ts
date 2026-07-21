/**
 * POST /api/packages/derive-secrets (issue #195).
 *
 * Backend for the package wizard's "Secret review" step: scan the packaged
 * content for secret / instance-specific values and return proposals the user
 * can confirm or reject. Runs the always-on offline heuristic pass and, only
 * when `modelIdentifier` is supplied, the optional model-driven pass.
 *
 * PRIVACY: the heuristic pass never leaves the machine. The model-driven pass
 * DOES send packaged content to the selected provider — the UI states this
 * before enabling it; the route only runs it when a model is explicitly chosen.
 *
 * Guarded fail-closed with `assertUnlocked` then `assertLocalRequest`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  deriveSecretsForSelection,
  type PackageSelection,
} from '@/backend/services/packages/buildPackage';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/derive-secrets/route');

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export async function POST(request: NextRequest) {
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

  const modelIdentifier =
    typeof raw.modelIdentifier === 'string' && raw.modelIdentifier.trim()
      ? raw.modelIdentifier.trim()
      : undefined;
  const entropyThreshold =
    typeof raw.entropyThreshold === 'number' && Number.isFinite(raw.entropyThreshold)
      ? raw.entropyThreshold
      : undefined;
  const enableEntropy = typeof raw.enableEntropy === 'boolean' ? raw.enableEntropy : undefined;

  try {
    const result = await deriveSecretsForSelection(selection, {
      modelIdentifier,
      entropyThreshold,
      enableEntropy,
    });
    return NextResponse.json(result);
  } catch (err) {
    log.error('Failed to derive package secrets', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to derive secrets' },
      { status: 500 },
    );
  }
}
