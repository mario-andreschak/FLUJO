import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLocalInstanceProof } from '../../../../../scripts/local-instance.mjs';

// FLUJO_INSTALLATION_WIDE_ROUTE: discovery must work while workspace storage is locked or migrating.
export const runtime = 'nodejs';

export function GET(request: Request): Response {
  const forbidden = assertLocalRequest(request, { strictLoopback: true });
  if (forbidden) return forbidden;
  const headers = { 'Cache-Control': 'no-store' };
  const nonce = new URL(request.url).searchParams.get('nonce');
  if (!nonce || !/^[a-f0-9]{64}$/.test(nonce)) {
    return Response.json({ error: 'Invalid instance challenge.' }, { status: 400, headers });
  }
  const proof = createLocalInstanceProof(nonce);
  return proof ? Response.json(proof, { headers })
    : Response.json({ error: 'Local instance discovery is unavailable.' }, { status: 503, headers });
}
