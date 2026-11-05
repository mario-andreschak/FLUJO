import { withWorkspaceRoute } from '@/app/api/_workspace';
import { admitOperationsRequest, recheckAdmission, workspaceForbidden, type Admission } from '@/app/api/operations/_admission';
import {
  applyConfiguredDesiredState,
  applyDesiredState,
  getDesiredStateOverview,
  rollbackDesiredState,
  type DesiredStateReport,
} from '@/backend/services/desiredState';
import { assertUnlocked, LOCKED_ERROR_CODE } from '@/utils/encryption/lockGate';
import { getCurrentWorkspace } from '@/utils/workspace';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** Far above any real file. Keeps one request from filling memory. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const STATUS_BY_OUTCOME: Record<DesiredStateReport['outcome'], number> = {
  applied: 200,
  unchanged: 200,
  'would-change': 200,
  'would-not-change': 200,
  'rolled-back': 200,
  'would-roll-back': 200,
  'held-back': 200,
  invalid: 422,
  locked: 423,
  'not-available': 409,
  failed: 500,
};

const plainError = (message: string, status: number): Response =>
  Response.json({ error: message }, { status, headers: NO_STORE });

/** Locked storage is reported and never worked around. */
async function lockedResponse(): Promise<Response | null> {
  const locked = await assertUnlocked();
  return locked ? Response.json({
    error: LOCKED_ERROR_CODE,
    message: 'This workspace is locked and has to be unlocked first. Nothing was changed.',
  }, { status: 423, headers: NO_STORE }) : null;
}

async function readBody(request: Request): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { response: plainError('The request is too large.', 413) };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { response: plainError('The request is too large.', 413) };
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return { body: body as Record<string, unknown> };
  } catch {
    return { response: plainError('The request must be a JSON object with an "action".', 400) };
  }
}

const POST_handler = async (request: Request, admission: Admission) => {
  const forbidden = workspaceForbidden(admission, getCurrentWorkspace());
  if (forbidden) return forbidden;
  const locked = await lockedResponse();
  if (locked) return locked;
  const read = await readBody(request);
  if ('response' in read) return read.response;
  const { action, state, dryRun } = read.body;
  let report: DesiredStateReport;
  if (action === 'apply' || action === 'dry-run') {
    const options = { dryRun: action === 'dry-run' };
    report = state === undefined ? await applyConfiguredDesiredState(options) : await applyDesiredState(state, options);
  } else if (action === 'rollback') {
    report = await rollbackDesiredState({ dryRun: dryRun === true });
  } else {
    return plainError('"action" must be "dry-run", "apply" or "rollback".', 400);
  }
  return Response.json(report, { status: STATUS_BY_OUTCOME[report.outcome], headers: NO_STORE });
};

const GET_handler = async (request: Request, admission: Admission) => {
  const forbidden = workspaceForbidden(admission, getCurrentWorkspace());
  if (forbidden) return forbidden;
  const locked = await lockedResponse();
  if (locked) return locked;
  const overview = await getDesiredStateOverview();
  const revoked = recheckAdmission(request, admission);
  if (revoked) return revoked;
  return Response.json(overview, { headers: NO_STORE });
};

const wrappedPost = withWorkspaceRoute(POST_handler);
const wrappedGet = withWorkspaceRoute(GET_handler);

/** Authentication comes before workspace or storage selection, as for the status route. */
export function POST(request: Request) {
  const admitted = admitOperationsRequest(request);
  return 'response' in admitted ? admitted.response : wrappedPost(request, admitted.admission);
}

export function GET(request: Request) {
  const admitted = admitOperationsRequest(request);
  return 'response' in admitted ? admitted.response : wrappedGet(request, admitted.admission);
}
