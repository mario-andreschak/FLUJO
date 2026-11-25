/**
 * POST /api/mcp/bundles — review or install an MCP bundle (.mcpb) file (#1230).
 *
 * Body: a form upload with
 *   - `bundle`: the .mcpb file
 *   - `action`: `review` (describe it, write nothing) or `install`
 *   - for `install`: `reviewedDigest` (from the review), `serverName` and
 *     `userConfig` (a JSON object with the bundle's settings)
 *
 * Review answers a `McpbReview`; install answers a `McpbInstallResult` (201).
 * Failures answer `{ error, code, fields? }` with words meant for the person.
 * The route is local-only and a `host` route: an installed bundle runs as a
 * program on this computer.
 */
import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { HostAccessRequiredError } from '@/backend/services/accounts/hostAccess';
import { formatBytes, mcpbLimits } from '@/backend/services/mcp/mcpb/archive';
import { installMcpbBundle, reviewMcpbBundle } from '@/backend/services/mcp/mcpb/install';
import { McpbError } from '@/backend/services/mcp/mcpb/manifest';
import type { McpbErrorBody } from '@/shared/types/mcp/mcpb';
import { json } from '../_helpers';

const log = createLogger('app/api/mcp/bundles/route');
const FORM_OVERHEAD_BYTES = 1024 * 1024;

function failure(body: McpbErrorBody, status: number): Response {
  return json(body, status);
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked();
  if (lock) return lock;

  const limits = mcpbLimits();
  const tooLarge = (size: number) => failure({
    error: `This bundle is ${formatBytes(size)}. FLUJO accepts bundles up to ${formatBytes(limits.bundleBytes)} on this computer.`,
    code: 'too-large',
  }, 413);
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limits.bundleBytes + FORM_OVERHEAD_BYTES) {
    return tooLarge(declaredLength);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failure({ error: 'Send the bundle as a form upload with a "bundle" file.', code: 'not-a-bundle' }, 400);
  }
  const file = form.get('bundle');
  if (!(file instanceof Blob)) return failure({ error: 'Choose a .mcpb file to install.', code: 'not-a-bundle' }, 400);
  if (file.size > limits.bundleBytes) return tooLarge(file.size);
  const bytes = Buffer.from(await file.arrayBuffer());
  const action = form.get('action');

  try {
    if (action === 'review') {
      return json(await reviewMcpbBundle(bytes, limits), 200);
    }
    if (action === 'install') {
      const reviewedDigest = form.get('reviewedDigest');
      const serverName = form.get('serverName');
      const rawConfig = form.get('userConfig');
      if (typeof reviewedDigest !== 'string' || typeof serverName !== 'string') {
        return failure({ error: 'Review the bundle before installing it.', code: 'changed-since-review' }, 400);
      }
      let userConfig: unknown = {};
      try {
        userConfig = typeof rawConfig === 'string' && rawConfig ? JSON.parse(rawConfig) : {};
      } catch {
        userConfig = undefined;
      }
      if (!userConfig || typeof userConfig !== 'object' || Array.isArray(userConfig)) {
        return failure({ error: 'The settings could not be read. Try again.', code: 'invalid-config' }, 400);
      }
      const result = await installMcpbBundle({
        bytes,
        reviewedDigest,
        serverName,
        userConfig: userConfig as Record<string, unknown>,
      }, limits);
      return json(result, 201);
    }
    return failure({ error: 'Unknown action: use "review" or "install".' }, 400);
  } catch (error) {
    if (error instanceof McpbError) {
      return failure({ error: error.message, code: error.code, ...(error.fields ? { fields: error.fields } : {}) }, error.status);
    }
    if (error instanceof HostAccessRequiredError) {
      return failure({ error: error.message, code: 'host-install-blocked' }, error.status);
    }
    log.error('Installing an MCP bundle failed', error);
    return failure({ error: 'Installing the bundle failed. The FLUJO log has the details.' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
