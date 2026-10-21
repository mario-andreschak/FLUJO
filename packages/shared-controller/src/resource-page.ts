import type { IncomingMessage, ServerResponse } from 'node:http';
import { opaque, type Session } from './ledger.js';
import { escapeHtml as html, jsonReply as json, readLocalForm, redirect, reply, securityHeaders } from './http.js';
import { TeamError, Teams } from './teams.js';
import { EDIT_SECONDS, RESOURCE_KINDS, TeamResources, type EditorLease, type ResourceRevision, type SharedResource } from './team-resources.js';
import { renderTeamPage } from './team-page.js';

const ROOT = '/_account/resources';
const hidden = (key: string, value: string | number) => `<input type="hidden" name="${html(key)}" value="${html(String(value))}">`;
const form = (action: string, values: Record<string, string | number>, content: string, asynchronous = false) =>
  `<form method="post" action="${ROOT}"${asynchronous ? ' data-async="true"' : ''}>${hidden('action', action)}${Object.entries(values).map(([key, value]) => hidden(key, value)).join('')}${content}</form>`;
const link = (teamId: string, id?: string) => `${ROOT}?team=${encodeURIComponent(teamId)}${id ? `&resource=${encodeURIComponent(id)}` : ''}`;
const number = (value: string | null | undefined) => /^[1-9][0-9]{0,14}$/.test(value ?? '') ? Number(value) : 0;
const date = (time: number) => html(new Date(time).toISOString().replace('T', ' '));
const fields: Readonly<Record<string, readonly string[]>> = {
  create: ['action', 'teamId', 'kind', 'name', 'content', 'consent'],
  edit: ['action', 'teamId', 'resourceId', 'version'],
  save: ['action', 'teamId', 'resourceId', 'version', 'token', 'fence', 'name', 'content'],
  renew: ['action', 'teamId', 'resourceId', 'token', 'fence'],
  release: ['action', 'teamId', 'resourceId', 'token', 'fence'],
  restore: ['action', 'teamId', 'resourceId', 'version', 'restoredFrom', 'consent'],
};

// All script bytes are trusted static source. Resource text and tokens stay in
// escaped form fields, never JavaScript literals. Failed saves retain the draft.
const script = `
const status = document.getElementById('resource-status');
const editor = document.querySelector('form[data-editor]');
let pending = false;
let renewing = false;
let dirty = false;
for (const field of document.querySelectorAll('textarea,input:not([type=hidden])')) field.addEventListener('input', () => { dirty = true; });
addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
for (const target of document.querySelectorAll('form:not([data-async])')) target.addEventListener('submit', () => { dirty = false; });
async function post(data) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/_account/resources', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: data });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status });
    return result;
  } finally { clearTimeout(timeout); }
}
for (const target of document.querySelectorAll('form[data-async]')) target.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return; pending = true;
  const button = target.querySelector('button[type=submit]'); if (button) button.disabled = true;
  status.textContent = 'Saving…';
  try { const result = await post(new URLSearchParams(new FormData(target))); dirty = false; location.assign(result.location); }
  catch (error) { status.textContent = error.message + ' Your draft is still below. Download it before leaving this page.'; if (button) button.disabled = false; }
  finally { pending = false; }
});
for (const button of document.querySelectorAll('[data-download-draft]')) button.addEventListener('click', () => {
  const text = document.querySelector('textarea[name=content]').value;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'flujo-team-draft.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
if (editor) {
  const timer = setInterval(async () => {
    if (pending || renewing) return;
    renewing = true;
    const data = new URLSearchParams({ action: 'renew' });
    for (const key of ['teamId','resourceId','token','fence']) data.set(key, editor.elements.namedItem(key).value);
    try { await post(data); }
    catch (error) {
      status.textContent = 'Could not renew the edit lock. ' + error.message + ' Download your draft before reloading.';
      if ([401,403,404,409].includes(error.status)) {
        clearInterval(timer); editor.querySelector('button[type=submit]').disabled = true;
      }
    } finally { renewing = false; }
  }, 20000);
}
`;

function render(response: ServerResponse, content: string, error = '', status = 200): void {
  const nonce = opaque();
  renderTeamPage(response, `<p id="resource-status" role="status" aria-live="polite"></p>${content}<script nonce="${nonce}">${script}</script>`, error, status, nonce);
}

function editor(resource: SharedResource, revision: ResourceRevision, lease: EditorLease): string {
  const values = { teamId: resource.teamId, resourceId: resource.id, version: resource.version, token: lease.token, fence: lease.fence };
  const edit = form('save', values, `<h1>Edit ${html(resource.name)}</h1><p>You hold the edit lock. It renews while this page remains connected; after ${EDIT_SECONDS} seconds without renewal, another member can edit. Saving creates a new revision and releases the lock.</p>
    <noscript><p>Automatic renewal requires JavaScript. Save within ${EDIT_SECONDS} seconds or keep a copy of your draft before acquiring a new lock.</p></noscript>
    <label for="resource-name">Name</label><input id="resource-name" name="name" value="${html(resource.name)}" required maxlength="120">
    <label for="resource-content">Resource JSON</label><textarea id="resource-content" name="content" required spellcheck="false">${html(revision.content)}</textarea>
    <p><button type="submit">Save revision</button> <button type="button" data-download-draft>Download draft</button></p>`, true).replace('data-async="true"', 'data-async="true" data-editor="true"');
  return `${edit}${form('release', { teamId: resource.teamId, resourceId: resource.id, token: lease.token, fence: lease.fence }, '<button>Discard edits and release lock</button>')}`;
}

export async function resourcePage(request: IncomingMessage, response: ServerResponse, teams: Teams, resources: TeamResources,
  session: Session, url: URL, current: () => boolean): Promise<void> {
  const ajax = request.headers.accept === 'application/json';
  let submitted: Record<string, string> | undefined;
  try {
    if (!current()) throw new TeamError(401, 'Your session ended. Sign in again.');
    if (request.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => !['team', 'resource', 'version', 'download'].includes(key))
          || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)) throw new TeamError(400, 'Invalid resource address.');
      const teamId = url.searchParams.get('team') ?? ''; const resourceId = url.searchParams.get('resource');
      const { team } = teams.detail(session, teamId);
      if (!resourceId) {
        if (url.searchParams.has('version') || url.searchParams.has('download')) throw new TeamError(400, 'Select a resource first.');
        const rows = resources.list(session, teamId);
        if (ajax) { json(response, { team, resources: rows }); return; }
        render(response, `<h1>${html(team.name)} · Shared resources</h1><p>Shared JSON is visible and editable by every current team member. Private originals stay in their owner’s workspace. These documents do not automatically run, connect services, or grant access to referenced private resources.</p>
          <ul>${rows.map(row => `<li><a href="${link(teamId, row.id)}">${html(row.name)}</a> · ${row.kind} · revision ${row.version}</li>`).join('')}</ul>
          <h2>Share a resource</h2><p>Review the complete JSON before sharing. The resource is stored locally. Native app editors and execution are not connected to this library yet.</p>
          ${form('create', { teamId }, `<label for="kind">Kind</label><select id="kind" name="kind">${RESOURCE_KINDS.map(kind => `<option value="${kind}">${kind}</option>`).join('')}</select>
            <label for="name">Name</label><input id="name" name="name" required maxlength="120">
            <label for="content">Resource JSON (up to 1 MiB)</label><textarea id="content" name="content" required spellcheck="false"></textarea>
            <label><input type="checkbox" name="consent" value="share" required>Share this complete content with every team member.</label>
            <p><button type="submit">Share resource</button> <button type="button" data-download-draft>Download draft</button></p>`, true)}`);
        return;
      }
      const selected = url.searchParams.has('version') ? number(url.searchParams.get('version')) : undefined;
      const data = resources.read(session, teamId, resourceId, selected);
      if (url.searchParams.has('download')) {
        if (url.searchParams.get('download') !== '1') throw new TeamError(400, 'Invalid download request.');
        securityHeaders(response);
        response.setHeader('Content-Disposition', `attachment; filename="${data.resource.kind}-${resourceId}-v${data.revision.version}.json"`);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(data.revision.content); return;
      }
      const versions = resources.history(session, teamId, resourceId);
      if (ajax) { json(response, { ...data, history: versions }); return; }
      render(response, `<p><a href="${link(teamId)}">All shared resources</a></p><h1>${html(data.revision.name)}</h1>
        ${data.resource.format === 'flujo.model.v1' ? `<p><a href="/teams/models?team=${teamId}&resource=${resourceId}">Open model editor</a></p>` : ''}
        <p>${data.resource.kind} · revision ${data.revision.version} · saved by ${html(data.revision.actorId)} at ${date(data.revision.time)}</p>
        <p><a href="${link(teamId, resourceId)}&version=${data.revision.version}&download=1">Download this revision</a></p>
        ${data.editor ? `<p>${html(data.editor.actorId)} is editing until ${date(data.editor.expiresAt)}. Reload after their lock ends.</p>`
          : form('edit', { teamId, resourceId, version: data.resource.version }, '<button>Edit current revision</button>')}
        <pre>${html(data.revision.content)}</pre>
        ${data.revision.version !== data.resource.version ? form('restore', { teamId, resourceId, version: data.resource.version, restoredFrom: data.revision.version },
          '<label><input type="checkbox" name="consent" value="restore" required>Restore this content as a new revision.</label><button>Restore revision</button>') : ''}
        <h2>Revision history</h2><ol>${versions.map(version => `<li><a href="${link(teamId, resourceId)}&version=${version.version}">Revision ${version.version}</a> · ${html(version.actorId)} · ${date(version.time)}${version.restoredFrom ? ` · restored from ${version.restoredFrom}` : ''}</li>`).join('')}</ol>`);
      return;
    }
    if (request.method !== 'POST') { reply(response, 405, 'Method not allowed.'); return; }
    if (url.search) throw new TeamError(400, 'Submit the form from your resource page.');
    const data = await readLocalForm(request, 4 * 1024 * 1024);
    const required = data && Object.hasOwn(fields, data.action) ? fields[data.action] : undefined;
    if (!data || !required || Object.keys(data).length !== required.length || required.some(key => !Object.hasOwn(data, key))) {
      throw new TeamError(400, 'Invalid resource form or upload too large.');
    }
    submitted = data;
    if (!current()) throw new TeamError(401, 'Your session ended. Sign in again.');
    let destination = link(data.teamId, data.resourceId);
    switch (data.action) {
      case 'create':
        if (data.consent !== 'share') throw new TeamError(400, 'Confirm sharing with this team.');
        destination = link(data.teamId, resources.create(session, data.teamId, data.kind, data.name, data.content)); break;
      case 'edit': {
        const lease = resources.acquire(session, data.teamId, data.resourceId, number(data.version));
        const snapshot = resources.read(session, data.teamId, data.resourceId);
        if (ajax) { json(response, { ...snapshot, lease }); return; }
        render(response, editor(snapshot.resource, snapshot.revision, lease)); return;
      }
      case 'save': resources.save(session, data.teamId, data.resourceId, data.token, number(data.fence), number(data.version), data.name, data.content); break;
      case 'renew': json(response, { expiresAt: resources.renew(session, data.teamId, data.resourceId, data.token, number(data.fence)) }); return;
      case 'release': resources.release(session, data.teamId, data.resourceId, data.token, number(data.fence)); break;
      case 'restore':
        if (data.consent !== 'restore') throw new TeamError(400, 'Confirm restoring this revision.');
        resources.restore(session, data.teamId, data.resourceId, number(data.version), number(data.restoredFrom)); break;
    }
    if (ajax) json(response, { location: destination }); else redirect(response, destination);
  } catch (error) {
    const failure = error instanceof TeamError ? error : new TeamError(503, 'Shared storage is temporarily unavailable. Keep your draft and retry.');
    if (ajax) { json(response, { error: failure.message }, failure.status); return; }
    // Without JavaScript, preserve only the submitted draft, never reread a
    // resource after authorization failed or echo its lease/other hidden fields.
    const draft = submitted && ['create', 'save'].includes(submitted.action)
      ? `<h2>Your submitted draft</h2><p>Copy or download this draft before reloading. Check the current revision before trying again.</p>
          <label for="draft-name">Name</label><input id="draft-name" value="${html(submitted.name)}" readonly>
          <label for="draft-content">Resource JSON</label><textarea id="draft-content" name="content" readonly>${html(submitted.content)}</textarea>
          <button type="button" data-download-draft>Download draft</button>` : '';
    render(response, `<h1>Shared resources</h1>${draft}<p>Return to your team to reload its current resources.</p>`, failure.message, failure.status);
  }
}
