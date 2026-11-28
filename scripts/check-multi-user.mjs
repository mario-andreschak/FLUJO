#!/usr/bin/env node
/**
 * Two-person check of multi-user mode (#574) against a running, throwaway
 * FLUJO, the way the browser talks to it. Start one with
 * `node scripts/flujo-drive.mjs launch`, then:
 *
 *   node scripts/check-multi-user.mjs --url http://127.0.0.1:<port> [--browser-steps <folder>] [--keep-on]
 *
 * It turns multi-user mode on (it must be off), adds two members, signs both
 * in and checks that each one sees only their own workspace and that every
 * kind of request to the other one's workspace (list, read, write, delete,
 * run, approve, subscribe, export; by query, by header) answers exactly like
 * a workspace that does not exist. It also checks sign-out, turning a person
 * off and on, and turning the mode off again (unless --keep-on).
 *
 * Teams (#575): the two members then share a team workspace. Both edit one
 * flow (one save wins, the other is a visible conflict that names the first),
 * the change history names both and restores, the edit note shows the other
 * person, a copy from a personal workspace arrives without its key, a viewer
 * can look but not change or run, and removing a member cuts them off.
 *
 * With --browser-steps <folder> it also writes two flujo-drive step files
 * (Ben signs in and lands in his own workspace; Ben opens Anna's workspace
 * link and is told it does not exist), runs them in a headless browser while
 * multi-user mode is still on, and deletes them again: they hold the
 * throwaway passwords made here. `npm run journey:multi-user` runs all of this
 * on a fresh production build. Prints one JSON summary; the exit code is 1
 * when a check fails.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function parse(argv) {
  const options = { url: undefined, browserSteps: undefined, keepOn: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--url') options.url = argv[++index];
    else if (argument === '--browser-steps') options.browserSteps = argv[++index];
    else if (argument === '--keep-on') options.keepOn = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!options.url) throw new Error('Pass --url http://127.0.0.1:<port> of a throwaway FLUJO (see scripts/flujo-drive.mjs launch).');
  const url = new URL(options.url);
  if (url.port === '4200') throw new Error('Never run this against the everyday FLUJO on port 4200. Use a throwaway instance.');
  return { ...options, url: url.origin };
}

export async function checkMultiUser({ url: given, browserSteps, keepOn = false }) {
  const url = new URL(given).origin;
  if (new URL(url).port === '4200') throw new Error('Never run this against the everyday FLUJO on port 4200. Use a throwaway instance.');
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) }); };
  const password = () => `check ${randomBytes(12).toString('base64url')} passphrase`;

  async function call(method, route, { cookie, body, headers = {} } = {}) {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        origin: url,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON, for example an event stream */ }
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, json, cookie: setCookie ? setCookie.split(';')[0] : undefined };
  }

  const start = await call('GET', '/api/accounts/session');
  if (start.json?.mode !== 'off') throw new Error('Multi-user mode is already on here. Use a fresh throwaway instance.');

  const people = {
    admin: { name: `check-admin-${randomBytes(3).toString('hex')}`, password: password() },
    anna: { name: `check-anna-${randomBytes(3).toString('hex')}`, password: password() },
    ben: { name: `check-ben-${randomBytes(3).toString('hex')}`, password: password() },
  };

  const enabled = await call('POST', '/api/accounts/mode', { body: { enabled: true, name: people.admin.name, password: people.admin.password } });
  check('turn on with a first admin', enabled.status === 200 && enabled.cookie, enabled);
  const admin = enabled.cookie;
  for (const person of [people.anna, people.ben]) {
    const added = await call('POST', '/api/accounts/users', { cookie: admin, body: { name: person.name, password: person.password } });
    check(`admin adds ${person.name}`, added.status === 201, added);
  }
  const signIn = async person => {
    const answer = await call('POST', '/api/accounts/session', { body: { name: person.name, password: person.password } });
    check(`${person.name} signs in`, answer.status === 200 && answer.cookie, answer);
    return answer;
  };
  const annaSignIn = await signIn(people.anna);
  const benSignIn = await signIn(people.ben);
  const anna = annaSignIn.cookie;
  const ben = benSignIn.cookie;
  const annaWs = annaSignIn.json?.createdWorkspace;
  const benWs = benSignIn.json?.createdWorkspace;
  check('each member gets a personal workspace', annaWs && benWs && annaWs !== benWs, { annaWs, benWs });

  const names = async cookie => ((await call('GET', '/api/workspaces', { cookie })).json?.workspaces ?? []).map(item => item.name);
  check('anna sees only her workspace', JSON.stringify(await names(anna)) === JSON.stringify([annaWs]), await names(anna));
  check('ben sees only his workspace', JSON.stringify(await names(ben)) === JSON.stringify([benWs]), await names(ben));
  check('the admin sees both', (await names(admin)).includes(annaWs) && (await names(admin)).includes(benWs), await names(admin));

  const matrix = [
    ['list', 'GET', '/api/flow'], ['read', 'GET', '/api/flow/no-such-flow'], ['write', 'POST', '/api/flow'],
    ['delete', 'DELETE', '/api/flow/no-such-flow'], ['run', 'POST', '/v1/chat/completions'],
    ['approve', 'POST', '/api/approvals/no-such-approval'], ['subscribe', 'GET', '/v1/chat/events'],
    ['export', 'POST', '/api/backup'], ['export', 'GET', '/api/env'],
  ];
  for (const [action, method, route] of matrix) {
    const viaQuery = await call(method, `${route}?workspace=${annaWs}`, { cookie: ben, body: method === 'GET' ? undefined : {} });
    const viaHeader = await call(method, route, { cookie: ben, headers: { 'x-flujo-workspace': annaWs }, body: method === 'GET' ? undefined : {} });
    const unknown = await call(method, `${route}?workspace=no-such-workspace`, { cookie: ben, body: method === 'GET' ? undefined : {} });
    const looksUnknown = answer => answer.status === 404 && answer.json?.error === `Unknown workspace: ${annaWs}`;
    check(`${action} ${method} ${route}: ben gets 404 for anna's workspace by query`, looksUnknown(viaQuery), viaQuery);
    check(`${action} ${method} ${route}: ben gets 404 for anna's workspace by header`, looksUnknown(viaHeader), viaHeader);
    check(`${action} ${method} ${route}: same answer as a workspace that does not exist`, unknown.status === 404, unknown);
  }
  const own = await call('GET', `/api/flow?workspace=${benWs}`, { cookie: ben });
  check('ben can use his own workspace', own.status === 200, own);
  const signedOut = await call('GET', `/api/flow?workspace=${benWs}`);
  check('signed out asks for sign-in', signedOut.status === 401 && signedOut.json?.code === 'ACCOUNT_SIGN_IN_REQUIRED', signedOut);
  const host = await call('GET', `/api/browse?workspace=${benWs}`, { cookie: ben });
  check('a member without host access cannot browse server folders', host.status === 403, host);

  const users = (await call('GET', '/api/accounts/users', { cookie: admin })).json?.users ?? [];
  const benId = users.find(user => user.name === people.ben.name)?.id;
  await call('PATCH', '/api/accounts/users', { cookie: admin, body: { id: benId, disabled: true } });
  const disabled = await call('GET', `/api/flow?workspace=${benWs}`, { cookie: ben });
  check('turning ben off ends his session at the next request', disabled.status === 401, disabled);
  await call('PATCH', '/api/accounts/users', { cookie: admin, body: { id: benId, disabled: false } });
  const back = await signIn(people.ben);
  check('ben can sign in again after being turned on', back.status === 200, back);

  const team = await checkTeamJourney({ call, check, admin, anna, ben: back.cookie, people, annaWs, benWs });

  const signOut = await call('DELETE', '/api/accounts/session', { cookie: anna });
  const afterSignOut = await call('GET', `/api/flow?workspace=${annaWs}`, { cookie: anna });
  check('sign-out ends the session', signOut.status === 200 && afterSignOut.status === 401, afterSignOut);

  let stepFiles = [];
  if (browserSteps) {
    await fs.mkdir(browserSteps, { recursive: true });
    const signInSteps = [
      { do: 'goto', route: '/owner/login' },
      { do: 'expect-text', text: 'Sign in to FLUJO' },
      { do: 'fill', label: 'Name', value: people.ben.name },
      { do: 'fill', label: 'Password', value: people.ben.password },
      { do: 'click', role: 'button', name: 'Sign in', exact: true },
      { do: 'wait-for', role: 'button', name: `Current workspace: ${benWs}`, timeout: 120000 },
    ];
    const ownFile = path.join(browserSteps, 'multi-user-own-workspace.json');
    await fs.writeFile(ownFile, JSON.stringify([...signInSteps,
      { do: 'shot', out: 'multi-user/ben-signed-in.png' }, { do: 'aria', out: 'multi-user/ben-signed-in.yml' }], null, 2));
    const otherFile = path.join(browserSteps, 'multi-user-other-workspace.json');
    await fs.writeFile(otherFile, JSON.stringify([...signInSteps,
      { do: 'goto', route: `/?workspace=${annaWs}`, deadEnd: true },
      { do: 'expect-text', text: `Unknown workspace: ${annaWs}` },
      { do: 'shot', out: 'multi-user/ben-opens-anna-link.png' }, { do: 'aria', out: 'multi-user/ben-opens-anna-link.yml' }], null, 2));
    stepFiles = [ownFile, otherFile];
    // The files hold throwaway passwords that work only while the mode is on, so they run now.
    for (const file of stepFiles) {
      const outcome = await runBrowserSteps(url, file);
      check(`browser: ${path.basename(file, '.json')}`, outcome.ok, outcome.error);
    }
    for (const file of stepFiles) await fs.rm(file, { force: true });
    await fs.rmdir(browserSteps).catch(() => undefined);
  }

  if (!keepOn) {
    const off = await call('POST', '/api/accounts/mode', { cookie: admin, body: { enabled: false } });
    const mode = await call('GET', '/api/accounts/session');
    const single = await call('GET', '/api/flow');
    check('turning the mode off brings back single-user FLUJO', off.status === 200 && mode.json?.mode === 'off' && single.status === 200, { off, mode, single });
  }

  const failed = results.filter(result => !result.ok);
  return {
    ok: failed.length === 0, checks: results.length, failed, workspaces: { anna: annaWs, ben: benWs, team: team.workspace },
    stepFiles, modeLeftOn: keepOn,
  };
}

/** Runs one flujo-drive step file in a fresh headless browser, the way `flujo-drive steps` does. */
async function runBrowserSteps(url, file) {
  const { loadChromium, runStep, validateSteps } = await import('./flujo-drive.mjs');
  const steps = validateSteps(JSON.parse(await fs.readFile(file, 'utf8')));
  const browser = await loadChromium();
  const pageErrors = [];
  let index = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message.split('\n')[0]));
    for (; index < steps.length; index++) await runStep(page, steps[index], `${url}/`, () => {});
    return pageErrors.length ? { ok: false, error: `errors on the page: ${pageErrors.join('; ')}` } : { ok: true };
  } catch (error) {
    return { ok: false, error: `step ${index + 1} (${steps[index]?.do}): ${String(error.message).split('\n')[0]}` };
  } finally {
    await browser.close();
  }
}

/** A flow with one start step, the smallest flow FLUJO saves. */
function checkFlow(id, name, properties = {}) {
  return {
    id, name, edges: [],
    nodes: [{ id: `${id}-start`, type: 'start', position: { x: 250, y: 150 },
      data: { label: 'Start Node', type: 'start', properties: { promptTemplate: '', ...properties } } }],
  };
}

/**
 * Two people in one team (#575): Anna owns the team, Ben is a member. They
 * share a team workspace, both edit one flow, one save wins and the other gets
 * a visible conflict, the history names both and restores, the edit note shows
 * the other person, a copy from a personal workspace leaves its secret behind,
 * a viewer can look but not change or run, and removing Ben cuts him off.
 */
async function checkTeamJourney({ call, check, admin, anna, ben, people, annaWs, benWs }) {
  const users = (await call('GET', '/api/accounts/users', { cookie: admin })).json?.users ?? [];
  const idOf = name => users.find(user => user.name === name)?.id;
  const annaId = idOf(people.anna.name);
  const benId = idOf(people.ben.name);
  const suffix = randomBytes(3).toString('hex');

  const made = await call('POST', '/api/accounts/teams', { cookie: admin, body: { name: `Check team ${suffix}`, ownerUserId: annaId } });
  const teamId = made.json?.team?.id;
  check('team: an admin makes a team with Anna as owner', made.status === 201 && teamId, made);
  const ownTeamTry = await call('POST', '/api/accounts/teams', { cookie: anna, body: { name: `Shadow ${suffix}` } });
  check('team: a team owner who is not an admin cannot make teams', ownTeamTry.status === 403, ownTeamTry);
  const added = await call('PATCH', '/api/accounts/teams', { cookie: anna, body: { teamId, member: { userId: benId, role: 'member' } } });
  check('team: Anna adds Ben as a member', added.status === 200, added);
  const selfPromotion = await call('PATCH', '/api/accounts/teams', { cookie: ben, body: { teamId, member: { userId: benId, role: 'owner' } } });
  check('team: Ben cannot make himself an owner', selfPromotion.status === 403, selfPromotion);

  const workspace = `check-team-${suffix}`;
  const createdWs = await call('POST', '/api/workspaces', { cookie: anna, body: { name: workspace, teamId } });
  check('team: Anna makes a team workspace', createdWs.status === 201, createdWs);
  const benTeamWs = await call('POST', '/api/workspaces', { cookie: ben, body: { name: `${workspace}-ben`, teamId } });
  check('team: a member cannot make team workspaces', benTeamWs.status === 404, benTeamWs);
  const names = async cookie => ((await call('GET', '/api/workspaces', { cookie })).json?.workspaces ?? []).map(item => item.name);
  check('team: both see the team workspace next to their own',
    (await names(anna)).includes(workspace) && (await names(ben)).includes(workspace) && !(await names(ben)).includes(annaWs),
    { anna: await names(anna), ben: await names(ben) });

  const inTeam = route => `${route}${route.includes('?') ? '&' : '?'}workspace=${workspace}`;
  const flowId = `check-flow-${suffix}`;
  const created = await call('POST', inTeam('/api/flow'), { cookie: ben, body: checkFlow(flowId, 'Check flow') });
  check('team: Ben makes a flow in the team workspace', created.status === 201, created);
  const opened = await call('GET', inTeam(`/api/flow/${flowId}`), { cookie: anna });
  check('team: Anna opens Ben\'s flow', opened.status === 200, opened);
  const base = `f${opened.json?.updatedAt ?? 0}`;

  const annaNote = await call('POST', inTeam('/api/edit-locks'), { cookie: anna, body: { kind: 'flow', id: flowId } });
  const benNote = await call('POST', inTeam('/api/edit-locks'), { cookie: ben, body: { kind: 'flow', id: flowId } });
  check('team: the edit note tells Ben that Anna has the flow open',
    annaNote.json?.enabled === true && (benNote.json?.others ?? []).some(other => other.name === people.anna.name), { annaNote, benNote });

  const save = (cookie, name, revision) => call('PUT', inTeam(`/api/flow/${flowId}`), {
    cookie, body: checkFlow(flowId, name), headers: { 'x-flujo-base-revision': revision },
  });
  const benSave = await save(ben, 'Check flow Ben', base);
  check('team: Ben saves first', benSave.status === 200, benSave);
  const annaSave = await save(anna, 'Check flow Anna', base);
  check('team: Anna\'s save from the older version is a visible conflict that names Ben',
    annaSave.status === 409 && annaSave.json?.code === 'EDIT_CONFLICT' && annaSave.json?.changedBy?.name === people.ben.name, annaSave);
  const annaAnyway = await save(anna, 'Check flow Anna', annaSave.json?.currentRevision ?? '');
  check('team: Anna saves hers over Ben\'s on purpose', annaAnyway.status === 200, annaAnyway);

  const history = await call('GET', inTeam(`/api/history?kind=flow&id=${flowId}`), { cookie: ben });
  const entries = history.json?.entries ?? [];
  check('team: the history names who did what, newest first',
    history.status === 200 && JSON.stringify(entries.map(entry => [entry.actor?.name, entry.action]))
      === JSON.stringify([[people.anna.name, 'saved'], [people.ben.name, 'saved'], [people.ben.name, 'created']]), history);
  const benVersion = entries.find(entry => entry.actor?.name === people.ben.name && entry.action === 'saved');
  const current = await call('GET', inTeam(`/api/flow/${flowId}`), { cookie: ben });
  const restored = await call('POST', inTeam('/api/history'), {
    cookie: ben, body: { kind: 'flow', id: flowId, entryId: benVersion?.entryId, baseRevision: `f${current.json?.updatedAt ?? 0}` },
  });
  const afterRestore = await call('GET', inTeam(`/api/flow/${flowId}`), { cookie: anna });
  check('team: Ben restores his version as a new version', restored.status === 200 && afterRestore.json?.name === 'Check flow Ben',
    { restored, afterRestore });

  const ranAsMember = await call('POST', inTeam('/v1/chat/completions'), { cookie: ben, body: { model: `flow-${flowId}`, messages: [] } });
  check('team: a member may run things (the request is not refused for access)',
    ![401, 403].includes(ranAsMember.status) && ranAsMember.json?.error !== `Unknown workspace: ${workspace}`, ranAsMember);

  const secret = `check-secret-${randomBytes(6).toString('hex')}`;
  const personalFlow = `check-personal-${suffix}`;
  const personal = await call('POST', `/api/flow?workspace=${benWs}`, { cookie: ben, body: checkFlow(personalFlow, 'Ben private flow', { apiKey: secret }) });
  check('copy: Ben has a flow with a key in his own workspace', personal.status === 201, personal);
  const copied = await call('POST', `/api/team-copy?workspace=${benWs}`, { cookie: ben, body: { kind: 'flow', id: personalFlow, targetWorkspace: workspace } });
  const copiedId = copied.json?.copied?.id;
  const copy = copiedId ? await call('GET', inTeam(`/api/flow/${copiedId}`), { cookie: anna }) : { status: 0 };
  check('copy: the copy reaches the team without the key', copied.status === 201 && copy.status === 200
    && !JSON.stringify(copy.json).includes(secret), { copied, copy: copy.status });
  const intoOthers = await call('POST', `/api/team-copy?workspace=${benWs}`, { cookie: ben, body: { kind: 'flow', id: personalFlow, targetWorkspace: annaWs } });
  check('copy: Ben cannot copy into Anna\'s personal workspace', intoOthers.status === 404, intoOthers);

  await call('PATCH', '/api/accounts/teams', { cookie: anna, body: { teamId, member: { userId: benId, role: 'viewer' } } });
  const viewerRead = await call('GET', inTeam(`/api/flow/${flowId}`), { cookie: ben });
  const viewerWrite = await save(ben, 'Viewer edit', `f${viewerRead.json?.updatedAt ?? 0}`);
  const viewerRun = await call('POST', inTeam('/v1/chat/completions'), { cookie: ben, body: { model: `flow-${flowId}`, messages: [] } });
  check('team: as a viewer Ben can look but not change or run',
    viewerRead.status === 200 && viewerWrite.status === 403 && viewerWrite.json?.code === 'TEAM_VIEW_ONLY' && viewerRun.status === 403,
    { viewerRead: viewerRead.status, viewerWrite, viewerRun });

  const removed = await call('PATCH', '/api/accounts/teams', { cookie: anna, body: { teamId, member: { userId: benId, remove: true } } });
  const afterRemoval = await call('GET', inTeam('/api/flow'), { cookie: ben });
  check('team: removing Ben cuts him off at the next request, like a workspace that does not exist',
    removed.status === 200 && afterRemoval.status === 404 && afterRemoval.json?.error === `Unknown workspace: ${workspace}`, afterRemoval);
  check('team: Anna keeps working after Ben is gone', (await call('GET', inTeam('/api/flow'), { cookie: anna })).status === 200, null);
  return { workspace, teamId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const summary = await checkMultiUser(parse(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
