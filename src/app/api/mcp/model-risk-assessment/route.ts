import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readBoundedBody } from '@/utils/http/boundedBody';
import { canonicalGithubRepository } from '@/backend/services/mcp/securityReview/githubSource';
import { assessMcpGithubRisk } from '@/backend/services/mcp/modelRiskAssessment/assessment';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function POST_handler(request: NextRequest): Promise<Response> {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;
  let body: { repositoryUrl: string; modelId: string; includeSource: boolean };
  try {
    const parsed: unknown = JSON.parse((await readBoundedBody(request, 4096)).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).some(key => !['repositoryUrl', 'modelId', 'includeSource'].includes(key))
      || typeof value.repositoryUrl !== 'string' || value.repositoryUrl.length > 300
      || typeof value.modelId !== 'string' || !value.modelId.trim() || value.modelId.length > 256
      || /[\x00-\x1f\x7f]/.test(value.modelId) || typeof value.includeSource !== 'boolean') throw new Error();
    canonicalGithubRepository(value.repositoryUrl);
    body = { repositoryUrl: value.repositoryUrl, modelId: value.modelId, includeSource: value.includeSource };
  } catch {
    return json({ error: 'Provide a public GitHub repository URL, saved model ID and explicit includeSource boolean in a JSON object of at most 4096 bytes.' }, 400);
  }
  return json({ success: true, review: await assessMcpGithubRisk(body.repositoryUrl, body.modelId, body.includeSource, request.signal) });
}

// Existing workspace-owner authorization and execution admission are preserved.
export const POST = withWorkspaceRoute(POST_handler);
