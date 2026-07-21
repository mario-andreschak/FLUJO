/**
 * POST /api/packages/resolve (issue #194).
 *
 * Backend for the package-creation wizard's "Dependency resolution" and "MCP
 * validation" steps: given the user's raw selection, walk it to its full
 * dependency closure (subflows, referenced models/servers, planned-exec flows)
 * and validate the selected MCP servers by reference (local-only servers are
 * reported as fatal). Returns ids + advisories only — no entity payloads and no
 * secret material.
 *
 * Guarded fail-closed with `assertUnlocked` then `assertLocalRequest`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  previewPackageSecrets,
  resolvePackageSelection,
  validateMcpSelection,
  type PackageSelection,
} from '@/backend/services/packages/buildPackage';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/resolve/route');

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
  const selection: PackageSelection = {
    flowIds: sanitizeStringArray(raw.flowIds),
    modelIds: sanitizeStringArray(raw.modelIds),
    mcpServerNames: sanitizeStringArray(raw.mcpServerNames),
    plannedExecutionIds: sanitizeStringArray(raw.plannedExecutionIds),
  };

  try {
    const { resolved, entities } = await resolvePackageSelection(selection);
    const mcp = validateMcpSelection(resolved.mcpServerNames, entities.mcpServers);
    const secrets = previewPackageSecrets(resolved, entities);
    return NextResponse.json({
      resolved,
      mcp: {
        ok: mcp.errors.length === 0,
        errors: mcp.errors,
        servers: mcp.packaged.map((s) => ({ name: s.name, sourceType: s.installOrigin.sourceType })),
      },
      secrets,
    });
  } catch (err) {
    log.error('Failed to resolve package selection', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve selection' },
      { status: 500 },
    );
  }
}
