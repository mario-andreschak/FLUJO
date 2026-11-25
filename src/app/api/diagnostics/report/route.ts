import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { collectDiagnosticReport } from '@/backend/services/diagnostics/report';
import { defaultDiagnosticReaders } from '@/backend/services/diagnostics/defaultSources';

export const dynamic = 'force-dynamic';

/**
 * GET /api/diagnostics/report
 * The diagnostic report for Settings → Privacy & usage. It is only returned to
 * the page that asked; FLUJO never sends it anywhere.
 */
async function GET_handler(_request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const report = await collectDiagnosticReport(defaultDiagnosticReaders);
  return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withWorkspaceRoute(GET_handler);
