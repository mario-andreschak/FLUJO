import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readBoundedBody } from '@/utils/http/boundedBody';
import { canonicalGithubRepository } from '@/backend/services/mcp/securityReview/githubSource';
import { reviewMcpGithubSource } from '@/backend/services/mcp/securityReview/review';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function POST_handler(request: NextRequest): Promise<Response> {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse((await readBoundedBody(request, 4096)).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== 'repositoryUrl' && key !== 'revision') || typeof body.repositoryUrl !== 'string'
      || body.repositoryUrl.length > 300 || (body.revision !== undefined && (typeof body.revision !== 'string' || !/^[a-f0-9]{40}$/i.test(body.revision)))) throw new Error();
    canonicalGithubRepository(body.repositoryUrl);
  } catch {
    return json({ error: 'Provide a public GitHub repository URL and optional complete commit SHA in a JSON object of at most 4096 bytes.' }, 400);
  }
  return json({ success: true, review: await reviewMcpGithubSource(body.repositoryUrl as string, body.revision as string | undefined, request.signal) });
}

// Owner authentication and workspace admission are provided by the shared wrapper.
export const POST = withWorkspaceRoute(POST_handler);
