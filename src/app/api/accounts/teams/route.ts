import { accountRequestUser, type AccountRequestUser } from '@/backend/services/accounts/requestAccess';
import {
  answerInvite, changeMember, createTeam, deleteTeam, renameTeam, teamCandidates, teamsFor,
} from '@/backend/services/accounts/teams';
import {
  accountErrorResponse, json, multiUserOff, readJsonObject, sameOriginChange, signInRequired,
} from '../_shared';

// FLUJO_INSTALLATION_WIDE_ROUTE: teams of a multi-user installation (#575). Each step checks the team itself.

export const runtime = 'nodejs';

type SignedIn = AccountRequestUser & { user: NonNullable<AccountRequestUser['user']> };

async function signedIn(request: Request): Promise<SignedIn | Response> {
  const current = await accountRequestUser(request);
  if (!current) return multiUserOff();
  if (!current.user) return signInRequired();
  return current as SignedIn;
}

/** The teams this person is in or invited to (admins: every team), and the people a team manager may add. */
export async function GET(request: Request): Promise<Response> {
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    return json({
      revision: current.accounts.revision,
      teams: teamsFor(current.accounts, current.user),
      people: teamCandidates(current.accounts, current.user),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Make a team (admins): `{ name, ownerUserId? }`. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body) return json({ error: 'Send the new team as JSON.' }, 400);
    return json({ team: await createTeam(body, current.user) }, 201);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/**
 * Change a team: `{ teamId, … }` with one of
 * - `name`: rename (team owners, admins);
 * - `member: { userId, role?, invite?, remove? }`: add, invite, change or remove a person (team owners, admins);
 * - `answer: 'accept' | 'decline'`: the signed-in person answers their own invitation.
 */
export async function PATCH(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body || typeof body.teamId !== 'string') return json({ error: 'Say which team to change.' }, 400);
    if (body.answer === 'accept' || body.answer === 'decline') {
      return json({ team: await answerInvite(body.teamId, body.answer === 'accept', current.user) });
    }
    if (body.member && typeof body.member === 'object' && !Array.isArray(body.member)) {
      return json({ team: await changeMember(body.teamId, body.member as Record<string, unknown>, current.user) });
    }
    if (body.name !== undefined) return json({ team: await renameTeam(body.teamId, body.name, current.user) });
    return json({ error: 'Say what to change: name, member or answer.' }, 400);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Delete a team that owns no workspace (admins): `{ teamId }`. */
export async function DELETE(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await signedIn(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body || typeof body.teamId !== 'string') return json({ error: 'Say which team to delete.' }, 400);
    await deleteTeam(body.teamId, current.user);
    return json({ deleted: body.teamId });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
