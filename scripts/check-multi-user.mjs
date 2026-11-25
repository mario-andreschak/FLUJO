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
 * With --browser-steps it writes two flujo-drive step files (sign in as the
 * first person; open the second person's workspace link as the first person)
 * for `node scripts/flujo-drive.mjs steps owner/login --file <file>`. They
 * contain only the throwaway test passwords made here; delete the folder
 * after the run. Prints one JSON summary; the exit code is 1 when a check fails.
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

export async function checkMultiUser({ url, browserSteps, keepOn = false }) {
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

  const signOut = await call('DELETE', '/api/accounts/session', { cookie: anna });
  const afterSignOut = await call('GET', `/api/flow?workspace=${annaWs}`, { cookie: anna });
  check('sign-out ends the session', signOut.status === 200 && afterSignOut.status === 401, afterSignOut);

  let stepFiles = [];
  if (browserSteps) {
    await fs.mkdir(browserSteps, { recursive: true });
    const signInSteps = [
      { do: 'fill', label: 'Name', value: people.ben.name },
      { do: 'fill', label: 'Password', value: people.ben.password },
      { do: 'click', role: 'button', name: 'Sign in' },
    ];
    const ownFile = path.join(browserSteps, 'multi-user-own-workspace.json');
    await fs.writeFile(ownFile, JSON.stringify([...signInSteps,
      { do: 'shot', out: 'multi-user/ben-signed-in.png' }, { do: 'aria', out: 'multi-user/ben-signed-in.yml' }], null, 2));
    const otherFile = path.join(browserSteps, 'multi-user-other-workspace.json');
    await fs.writeFile(otherFile, JSON.stringify([...signInSteps,
      { do: 'goto', route: `/?workspace=${annaWs}` },
      { do: 'expect-text', text: `Unknown workspace: ${annaWs}` },
      { do: 'shot', out: 'multi-user/ben-opens-anna-link.png' }], null, 2));
    stepFiles = [ownFile, otherFile];
  }

  if (!keepOn) {
    const off = await call('POST', '/api/accounts/mode', { cookie: admin, body: { enabled: false } });
    const mode = await call('GET', '/api/accounts/session');
    const single = await call('GET', '/api/flow');
    check('turning the mode off brings back single-user FLUJO', off.status === 200 && mode.json?.mode === 'off' && single.status === 200, { off, mode, single });
  }

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, checks: results.length, failed, workspaces: { anna: annaWs, ben: benWs }, stepFiles, modeLeftOn: keepOn };
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
