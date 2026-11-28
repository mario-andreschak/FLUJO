import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * POST /api/packages/uninstall (issue #211).
 *
 * The de-provisioning counterpart to POST /api/packages/install: reverse a
 * package install by deleting only the entities the install actually CREATED
 * (flows, models, MCP servers, planned executions) and dropping the ledger
 * entry. Entities the install adopted/updated in place (e.g. a pre-existing
 * model matched by displayName) are left intact.
 *
 * Same posture as install: fail-closed behind `assertUnlocked` +
 * `assertLocalRequest`, and deliberately NOT on the public API allow-list.
 *
 * Body: { packageName: string, plan?: { flows: { [flowId]: { choices } }, servers: { [name]: { choices } } } }
 * Response: the UninstallSummary (removed / skipped / errors). Partial failures
 * still return 200 with `hasErrors: true` so the client can surface them.
 * An unknown package returns 404. When a Persona, automation or flow outside
 * the package still uses one of its flows or apps, nothing is removed and the
 * answer is 409 `PACKAGE_IN_USE` with every such place (#1389); send the
 * person's answers as `plan` to switch or release them first.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  inspectPackageUninstall,
  uninstallPackage,
} from '@/backend/services/packages/installPackage';
import { currentSharedEditor } from '@/backend/services/sharedItems/guard';
import { PACKAGE_IN_USE_CODE, parsePackageUninstallPlan } from '@/shared/types/package/uninstall';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/uninstall/route');

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

  const { packageName } = (body ?? {}) as { packageName?: unknown };
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    return NextResponse.json({ error: 'packageName is required' }, { status: 400 });
  }
  const plan = parsePackageUninstallPlan(body);
  if (plan === 'invalid') {
    return NextResponse.json({ error: 'The choices for removing this package could not be read.' }, { status: 400 });
  }

  // Resolve every package-owned planned execution before mutating anything.
  // Persona plans retain the same strict-loopback posture as their dedicated
  // scheduler route; legacy-only package uninstall remains network-compatible.
  const inspection = await inspectPackageUninstall(packageName);
  if (!inspection.exists) {
    return NextResponse.json({ error: `No install record for package "${packageName}"` }, { status: 404 });
  }
  if (inspection.requiresPersonaControl || (plan && inspection.answersTouchPersonaAutomations)) {
    const notLoopback = assertLocalRequest(request, { strictLoopback: true });
    if (notLoopback) return notLoopback;
  }

  log.info(`Uninstalling package "${packageName}"`);

  const summary = await uninstallPackage(packageName, {
    allowPersonaPlannedExecutions: inspection.requiresPersonaControl,
    plan,
    editor: await currentSharedEditor(),
  });
  if (summary.usage) {
    return NextResponse.json({
      error: summary.changed
        ? 'Something changed while you were choosing. Check the choices again.'
        : "Some of this package's flows or apps are still used outside it. Choose what each place uses instead, and remove the package again.",
      code: PACKAGE_IN_USE_CODE,
      usage: summary.usage,
      ...(summary.changed ? { changed: true } : {}),
      removed: summary.removed,
    }, { status: 409 });
  }
  if (summary.refusal) {
    return NextResponse.json({ error: summary.refusal, code: 'PACKAGE_UNINSTALL_REFUSED' }, { status: 409 });
  }
  return NextResponse.json(summary, { status: 200 });
}

export const POST = withWorkspaceRoute(POST_handler);
