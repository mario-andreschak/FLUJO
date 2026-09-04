import { createHash, timingSafeEqual } from 'node:crypto';

function tokenMatches(provided: string, expected: string): boolean {
  const digest = (value: string): Buffer =>
    createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Require the dedicated hot-clone control token. This token is deliberately
 * independent from encryption unlock state and is never returned by an API.
 */
export function assertSnapshotBearer(request: Request): Response | null {
  const expected = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim();
  if (!expected) {
    return Response.json(
      { error: 'Snapshot control plane is not configured.' },
      { status: 503 },
    );
  }

  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(authorization);
  const provided = match?.[1] ?? '';
  if (!provided || !tokenMatches(provided, expected)) {
    return Response.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
      },
    );
  }

  return null;
}
