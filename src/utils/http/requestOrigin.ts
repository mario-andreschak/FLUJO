/** Browser-facing origin, including when Next's URL uses the container listener.
 * The deployment proxy must strip untrusted forwarding headers before setting them.
 * Host remains subject to FLUJO's existing request host/authentication guards.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const publicProtocol = protocol === 'http' || protocol === 'https' ? `${protocol}:` : url.protocol;
  return new URL(`${publicProtocol}//${forwardedHost || host || url.host}`).origin;
}
