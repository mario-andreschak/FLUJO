import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * POST /api/packages/build (issue #194).
 *
 * Builds and serializes a package manifest from the user's selection, metadata,
 * and accepted secret-redaction proposals. This route is local-only and requires
 * the encrypted store to be unlocked.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  buildPackageManifest,
  type PackageMetadataInput,
  type PackageSelection,
} from '@/backend/services/packages/buildPackage';
import type { SecretProposal } from '@/shared/types/package/secretProposal';
import type { PackageGlobal } from '@/shared/types/package/package';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/build/route');

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
  if (!raw.selection || typeof raw.selection !== 'object') {
    return NextResponse.json({ error: 'Package selection is required' }, { status: 400 });
  }
  if (!raw.metadata || typeof raw.metadata !== 'object') {
    return NextResponse.json({ error: 'Package metadata is required' }, { status: 400 });
  }

  const metadata = raw.metadata as Record<string, unknown>;
  if (
    typeof metadata.id !== 'string' ||
    typeof metadata.name !== 'string' ||
    typeof metadata.version !== 'string'
  ) {
    return NextResponse.json(
      { error: 'Package metadata must include string id, name, and version fields' },
      { status: 400 },
    );
  }

  try {
    const result = await buildPackageManifest(
      raw.selection as PackageSelection,
      raw.metadata as PackageMetadataInput,
      Array.isArray(raw.acceptedSecrets) ? (raw.acceptedSecrets as SecretProposal[]) : [],
      Array.isArray(raw.globals) ? (raw.globals as PackageGlobal[]) : [],
      Array.isArray(raw.excludedSecrets)
        ? raw.excludedSecrets.filter((value): value is string => typeof value === 'string')
        : [],
    );
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    log.error('Failed to build package manifest', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build package manifest' },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
