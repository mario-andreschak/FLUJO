import { createToken, publicToken, revokeToken } from '@/backend/services/accounts/admin';
import { accountRequestUser } from '@/backend/services/accounts/requestAccess';
import { accountErrorResponse, json, multiUserOff, readJsonObject, sameOriginChange, signInRequired } from '../_shared';

// FLUJO_INSTALLATION_WIDE_ROUTE: each person's own API tokens in a multi-user installation (#574).

export const runtime = 'nodejs';

async function signedIn(request: Request) {
  const current = await accountRequestUser(request);
  if (!current) return multiUserOff();
  if (!current.user) return signInRequired();
  return { accounts: current.accounts, user: current.user };
}

/** The signed-in person's tokens (never the tokens themselves). */
export async function GET(request: Request): Promise<Response> {
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    return json({ tokens: current.accounts.apiTokens.filter(token => token.userId === current.user.id).map(publicToken) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Make a token: `{ label?, scopes?, expiresInDays? }`. The answer shows the token once. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request) ?? {};
    const { token, record } = await createToken(current.user.id, body);
    return json({ token, record }, 201);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Revoke a token: `{ id }`. */
export async function DELETE(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body || typeof body.id !== 'string') return json({ error: 'Say which token to revoke.' }, 400);
    await revokeToken(body.id, current.user);
    return json({ revoked: body.id });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
