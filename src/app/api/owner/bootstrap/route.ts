import { isOwnerBootstrapRequest, pairFirstOwner } from '@/backend/services/security/ownerBootstrap';
import { readBoundedBody } from '@/utils/http/boundedBody';

function json(body: unknown, status: number, cookie?: string) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
export function GET(request: Request) {
  return isOwnerBootstrapRequest(request) ? json({ pairingAvailable: true }, 200) : json({ pairingAvailable: false }, 403);
}
export async function POST(request: Request) {
  if (!isOwnerBootstrapRequest(request)) return json({ error: 'Owner pairing is unavailable.' }, 403);
  try {
    const bytes = await readBoundedBody(request, 256);
    let input;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); }
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || input.confirmOwnerEnrollment !== true) throw new Error();
    const paired = pairFirstOwner(request, true);
    return json({ ownerToken: paired.token, authenticated: Boolean(paired.cookie) }, 201, paired.cookie);
  } catch { return json({ error: 'Owner pairing failed. Preserve existing policy; regenerate a local capability only if no owner is enrolled.' }, 400); }
}
