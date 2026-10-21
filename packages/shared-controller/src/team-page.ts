import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from './ledger.js';
import { escapeHtml as html, readLocalForm, redirect, reply, securityHeaders } from './http.js';
import { TeamError, Teams, type TeamSummary } from './teams.js';

const ROOT = '/_account/teams';
const fields: Readonly<Record<string, readonly string[]>> = {
  create: ['action', 'name'], rename: ['action', 'teamId', 'generation', 'name'],
  invite: ['action', 'teamId', 'generation', 'actorId'], remove: ['action', 'teamId', 'generation', 'actorId'],
  accept: ['action', 'teamId', 'invitation'], decline: ['action', 'teamId', 'invitation'],
  archive: ['action', 'teamId', 'generation', 'confirm'],
};
const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${html(name)}" value="${html(String(value))}">`;
const form = (action: string, values: Record<string, string | number>, content: string): string =>
  `<form method="post" action="${ROOT}">${hidden('action', action)}${Object.entries(values).map(([key, value]) => hidden(key, value)).join('')}${content}</form>`;
const teamFields = (team: TeamSummary) => ({ teamId: team.id, generation: team.generation });
const date = (time: number) => html(new Date(time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'));
const labels: Readonly<Record<string, string>> = { created: 'Created the team', renamed: 'Renamed the team',
  invited: 'Invited', joined: 'Joined the team', declined: 'Declined the invitation', removed: 'Removed',
  left: 'Left the team', 'invitation-withdrawn': 'Withdrew the invitation for', archived: 'Archived the team' };

function render(response: ServerResponse, content: string, error: string, status: number): void {
  securityHeaders(response);
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your local teams · FLUJO</title><style>
  :root{color-scheme:dark;font:17px system-ui}*{box-sizing:border-box}body{margin:0;background:#101318;color:#edf1f7}main{max-width:52rem;margin:auto;padding:clamp(1rem,4vw,2rem)}h1{font-size:2rem}h2{margin-top:2rem}p,li{line-height:1.6}p,small{color:#c0cad7}a{color:#9ce4ca}button,input{font:inherit}button{padding:.65rem 1rem;border:0;border-radius:.4rem;background:#9ce4ca;color:#10241e;cursor:pointer;min-height:44px}input:not([type=hidden]):not([type=checkbox]){width:100%;max-width:32rem;padding:.7rem;margin:.4rem 0 .8rem;border:1px solid #8593a5;border-radius:.3rem;background:#19212b;color:inherit}label{display:block}form{margin:1rem 0}li{overflow-wrap:anywhere}li form{display:inline-block;margin:.4rem .5rem .4rem 0}ul,ol{padding-left:1.3rem}.card{border:1px solid #455163;border-radius:.6rem;padding:1rem;margin:1rem 0;overflow-wrap:anywhere}.alert{padding:1rem;border:1px solid #f2bf77;color:#ffdcab}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid white;outline-offset:4px}nav{display:flex;gap:1rem;flex-wrap:wrap}small{display:block}input[type=checkbox]{width:1.2rem;height:1.2rem;vertical-align:middle;margin-right:.5rem}
  </style></head><body><main><nav aria-label="Account"><a href="/_account">Your account</a><a href="${ROOT}">Your teams</a><a href="/">Back to FLUJO</a></nav>
  ${error ? `<p class="alert" role="alert">${html(error)}</p><p><a href="${ROOT}">Reload your teams</a></p>` : ''}${content}</main></body></html>`);
}

function page(teams: Teams, session: Session, teamId: string | null): string {
  if (!teamId) {
    const result = teams.list(session);
    return `<h1>Your local teams</h1><p>Your account ID is <strong>${html(session.actorId)}</strong>. Share this ID with a team creator on this installation. Invitations appear here and need your acceptance. No email or internet is required.</p>
    <p>Joining a team establishes membership. Your private Models, MCP servers, Flows, Chats and Executions stay private until resource sharing is available and you explicitly share them.</p>
    <h2>Create a team</h2>${form('create', {}, '<label for="team-name">Team name</label><input id="team-name" name="name" required maxlength="80" autocomplete="off"><button>Create team</button>')}
    <h2>Teams you joined</h2>${result.teams.length ? `<ul>${result.teams.map(team => `<li><a href="${ROOT}?team=${team.id}">${html(team.name)}</a>${team.creatorId === session.actorId ? ' · You manage membership' : ''}</li>`).join('')}</ul>` : '<p>You have not joined any teams yet.</p>'}
    <h2>Invitations</h2>${result.invitations.length ? result.invitations.map(invitation => `<section class="card"><h3>${html(invitation.name)}</h3><p>Created by ${html(invitation.creatorId)}. Invitation expires ${date(invitation.expiresAt)}.</p>
      ${form('accept', { teamId: invitation.id, invitation: invitation.invitation }, '<button>Accept invitation</button>')}
      ${form('decline', { teamId: invitation.id, invitation: invitation.invitation }, '<button>Decline invitation</button>')}</section>`).join('') : '<p>No pending invitations.</p>'}`;
  }
  const { team, members, events } = teams.detail(session, teamId);
  const creator = team.creatorId === session.actorId;
  return `<h1>${html(team.name)}</h1><p>${html(team.creatorId)} manages membership. All team members will have the same access to explicitly shared resources. Joining does not expose anyone’s private workspace.</p>
    <h2>Members and invitations</h2><ul>${members.map(member => `<li><strong>${html(member.actorId)}</strong>${member.actorId === team.creatorId ? ' · Creator' : ''} · ${member.state === 'member' ? 'Member' : 'Invited'}${member.available ? '' : ' · Account unavailable'}
      ${member.expiresAt ? `<small>Expires ${date(member.expiresAt)}</small>` : ''}
      ${creator && member.actorId !== team.creatorId ? form('remove', { ...teamFields(team), actorId: member.actorId }, `<button>${member.state === 'member' ? 'Remove member' : 'Withdraw invitation'}</button>`) : ''}</li>`).join('')}</ul>
    ${creator ? `<h2>Invite a local account</h2>${form('invite', teamFields(team), '<label for="actor-id">Exact local account ID</label><input id="actor-id" name="actorId" required maxlength="64" pattern="[A-Za-z0-9_-]+" autocomplete="off" autocapitalize="none" spellcheck="false"><button>Invite</button>')}
      <h2>Team name</h2>${form('rename', teamFields(team), `<label for="rename">Name</label><input id="rename" name="name" required maxlength="80" value="${html(team.name)}"><button>Save name</button>`)}
      <h2>Archive this team</h2><p>Archiving removes every membership and pending invitation. The local record is retained. To collaborate again, create a new team.</p>${form('archive', teamFields(team), '<label><input type="checkbox" name="confirm" value="archive" required>I want to archive this team.</label><button>Archive team</button>')}`
      : `<h2>Leave team</h2><p>You will need a new invitation to rejoin.</p>${form('remove', { ...teamFields(team), actorId: session.actorId }, '<button>Leave team</button>')}`}
    <h2>Membership activity</h2><p>The latest 200 membership events are retained locally.</p><ol>${events.map(event => `<li>${html(event.actorId)} · ${html(labels[event.action] ?? 'Updated membership')}${event.subjectId && event.subjectId !== event.actorId ? ` ${html(event.subjectId)}` : ''}<small>${date(event.time)}</small></li>`).join('')}</ol>`;
}

/** Called only after controller session and exact browser Origin admission. */
export async function teamPage(request: IncomingMessage, response: ServerResponse, teams: Teams,
  session: Session, url: URL, current: () => boolean): Promise<void> {
  try {
    if (!current()) throw new TeamError(401, 'Your session ended. Sign in again.');
    if (url.pathname !== ROOT || [...url.searchParams.keys()].some(key => key !== 'team')
        || url.searchParams.getAll('team').length > 1) throw new TeamError(404, 'Page unavailable.');
    if (request.method === 'GET') { render(response, page(teams, session, url.searchParams.get('team')), '', 200); return; }
    if (request.method !== 'POST') { reply(response, 405, 'Method not allowed.'); return; }
    if (url.search) throw new TeamError(400, 'Submit the form from your team page.');
    const data = await readLocalForm(request);
    if (!current()) throw new TeamError(401, 'Your session ended. Sign in again.');
    const required = data && Object.hasOwn(fields, data.action) ? fields[data.action] : undefined;
    if (!data || !required || Object.keys(data).length !== required.length || required.some(key => !Object.hasOwn(data, key))) {
      throw new TeamError(400, 'Invalid team form. Reload the page and try again.');
    }
    const generation = /^[1-9][0-9]{0,14}$/.test(data.generation ?? '') ? Number(data.generation) : 0;
    let destination = ROOT;
    switch (data.action) {
      case 'create': destination += `?team=${teams.create(session, data.name)}`; break;
      case 'rename': teams.rename(session, data.teamId, generation, data.name); destination += `?team=${data.teamId}`; break;
      case 'invite': teams.invite(session, data.teamId, generation, data.actorId); destination += `?team=${data.teamId}`; break;
      case 'remove': teams.remove(session, data.teamId, generation, data.actorId); if (data.actorId !== session.actorId) destination += `?team=${data.teamId}`; break;
      case 'accept': teams.respond(session, data.teamId, data.invitation, true); destination += `?team=${data.teamId}`; break;
      case 'decline': teams.respond(session, data.teamId, data.invitation, false); break;
      case 'archive':
        if (data.confirm !== 'archive') throw new TeamError(400, 'Confirm that you want to archive the team.');
        teams.archive(session, data.teamId, generation); break;
    }
    redirect(response, destination);
  } catch (error) {
    if (!(error instanceof TeamError)) throw error;
    render(response, `<h1>Your local teams</h1>${error.status === 401 ? '<p><a href="/_account">Sign in again</a></p>' : ''}`, error.message, error.status);
  }
}
