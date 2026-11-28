#!/usr/bin/env node
// Several people on one FLUJO, checked the way they would use it (#574, #575). Two throwaway FLUJOs
// from the production build, each with an empty data folder on a free port (never 4200):
//  1. scripts/check-multi-user.mjs: two people each see only their own workspace (every kind of
//     request to the other one's answers like a workspace that does not exist), the team rules,
//     and two browser steps (sign in; open the other person's workspace link).
//  2. Two browsers at once, through the screens only: Anna turns on sign-in and adds Ben; Ben signs
//     in and gets his own workspace; Anna makes a team with a team workspace and an agent in it; both open the agent and see that the
//     other is editing it; Ben saves first, Anna gets "Someone else saved first" and saves hers
//     anyway; the change history names both and restores Ben's version; Ben copies his own agent
//     into the team; Anna removes Ben from the team and his next visit is refused; Anna turns
//     sign-in off again. Run `npm run build` first.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkMultiUser } from '../check-multi-user.mjs';
import { EVIDENCE_DIR, loadChromium, parseArgs, parseViewport, runStep, save } from '../flujo-drive.mjs';
import { startProductionFlujo } from '../first-journey/production.mjs';

const EVIDENCE = 'multi-user';
const WAIT = 120_000;

export const USAGE = `Usage: node scripts/multi-user-journey/run.mjs [--viewport WxH]

Checks several people on one FLUJO: the two-person isolation and team checks of
scripts/check-multi-user.mjs (with its browser steps), then a team journey in two browsers at once
through the screens. Each part starts its own throwaway FLUJO from the production build ("npm run
build" first) and deletes it at the end. Screenshots, accessibility snapshots and report.json are
saved under ${path.join(EVIDENCE_DIR, EVIDENCE)}. Exit code 0 means every check passed.`;

/** Plain names for the team journey; passwords are made per run and never leave this process. */
export function journeyPeople(suffix = randomBytes(3).toString('hex')) {
  const password = () => `journey ${randomBytes(12).toString('base64url')} words`;
  return {
    anna: { name: `anna-${suffix}`, display: 'Anna', password: password() },
    ben: { name: `ben-${suffix}`, display: 'Ben', password: password() },
    team: `Check team ${suffix}`,
    workspace: `check-team-${suffix}`,
    flow: 'Team notes',
    benFlow: 'Ben notes',
  };
}

const goto = (route) => ({ do: 'goto', route });
const click = (role, name, extra = {}) => ({ do: 'click', role, name, ...extra });
const fill = (label, value, extra = {}) => ({ do: 'fill', label, value, exact: true, ...extra });
const see = (text, extra = {}) => ({ do: 'expect-text', text, ...extra });
const waitFor = (role, name, extra = {}) => ({ do: 'wait-for', role, name, timeout: WAIT, ...extra });

/** Saves a new agent in the simple builder of the open workspace. */
function buildAgent(name, goal) {
  return [
    click('button', 'Start simple'),
    fill('Workflow goal', goal, { exact: false }),
    click('button', 'Create goal step'),
    fill('Agent name', name, { exact: false }),
    click('button', 'Save flow'),
    SAVED,
  ];
}

/** The editor's save chip; a one-step agent reads "1 agent step Saved" (and "… Unsaved" before). */
const SAVED = { do: 'expect-text', text: 'agent step Saved' };
const BEN_TASK = 'Ben: keep notes for the weekly meeting.';
const ANNA_TASK = 'Anna: keep notes for the planning day.';
const conflictDialog = { role: 'dialog', name: 'Someone else saved first' };
const historyDialog = { role: 'dialog', name: 'Who changed this flow' };

/** Changes what the agent's AI step does, in the simple builder; the change applies when the field is left. */
function changeTask(text) {
  return [fill('What should the AI do?', text), { do: 'press', key: 'Tab' }];
}

/** Each stage acts in one person's browser and checks what that person sees. */
export function teamStages(people) {
  const { anna, ben, team, workspace } = people;
  const teamSection = { role: 'region', name: `Team ${team}`, exact: true };
  const inWorkspace = (name) => (route) => `${route}${route.includes('?') ? '&' : '?'}workspace=${name}`;
  const inTeam = inWorkspace(workspace);
  const inOwn = inWorkspace(ben.name);
  const copyDialog = `Copy “${people.benFlow}” to another workspace`;
  const openAgent = (who, name) => [goto(inTeam('/flows')), click('button', 'Edit', { exact: true, within: { role: 'article', name, exact: true } }),
    waitFor('button', 'Save flow')];
  return [
    { id: 'anna-turns-on-sign-in', who: 'anna', title: 'Anna turns on sign-in for several people in Settings', steps: [
      goto('/settings'), click('button', 'Users and sign-in'),
      fill('Your sign-in name', anna.name), fill('Display name', anna.display), fill('Password', anna.password), fill('Repeat password', anna.password),
      click('button', 'Turn on sign-in'), see(`Signed in as`),
    ] },
    { id: 'anna-adds-ben', who: 'anna', title: 'Anna adds Ben as a person', steps: [
      fill('Sign-in name', ben.name), fill('Display name', ben.display), fill('Password', ben.password),
      click('button', 'Add person'), see(`Added ${ben.name}. They can sign in now.`),
      see(ben.name, { within: { role: 'table', name: 'People' } }),
    ] },
    // Someone with no workspace gets a personal one at their first sign-in, so Ben signs in before he joins a team.
    { id: 'ben-signs-in', who: 'ben', title: 'Ben signs in and lands in his own new workspace', steps: [
      goto('/owner/login'), see('Sign in to FLUJO'), fill('Name', ben.name), fill('Password', ben.password), click('button', 'Sign in', { exact: true }),
      waitFor('button', `Current workspace: ${ben.name}`),
    ] },
    { id: 'anna-makes-team', who: 'anna', title: 'Anna makes a team, adds Ben as a member and makes a team workspace', steps: [
      fill('Team name', team), { do: 'select', label: 'First owner (optional)', option: anna.display, exactOption: false },
      click('button', 'Make team'), waitFor('region', `Team ${team}`, { exact: true }),
      { do: 'select', label: `Person to add to ${team}`, option: ben.display, within: teamSection },
      { do: 'select', label: `Role in ${team}`, option: 'Member', within: teamSection },
      { do: 'select', label: `How to add to ${team}`, option: 'Add now', within: teamSection },
      click('button', 'Add to team', { within: teamSection }),
      see(ben.display, { within: { role: 'table', name: `Members of ${team}` } }),
      fill(`New workspace for ${team}`, workspace, { within: teamSection }),
      click('button', 'Make team workspace', { within: teamSection }),
      click('button', `Open ${workspace}`, { within: teamSection }),
    ] },
    { id: 'anna-builds-team-agent', who: 'anna', title: 'Anna saves an agent in the team workspace', steps: [
      goto(inTeam('/flows')), ...buildAgent(people.flow, 'Keep notes for the team.'),
    ] },
    { id: 'ben-opens-team-workspace', who: 'ben', title: 'Ben opens the team workspace and finds Anna’s agent', steps: [
      goto(inTeam('/flows')), waitFor('article', people.flow, { exact: true }),
    ] },
    { id: 'both-open-the-agent', who: 'both', title: 'Both open the agent and each sees the other is editing it', steps: {
      anna: openAgent('anna', people.flow),
      ben: [...openAgent('ben', people.flow), see(`${anna.display} is editing this too.`)],
      annaAfter: [see(`${ben.display} is editing this too.`, { timeout: 60_000 })],
    } },
    { id: 'conflict', who: 'both', title: 'Ben saves first; Anna is asked what to keep and saves hers anyway', steps: {
      ben: [...changeTask(BEN_TASK), click('button', 'Save flow'), SAVED],
      anna: [...changeTask(ANNA_TASK), click('button', 'Save flow'),
        waitFor('dialog', conflictDialog.name), see(`${ben.display} saved this`, { within: conflictDialog }),
        click('button', 'Compare', { within: conflictDialog }),
        waitFor('table', 'Differences between your version and theirs'),
        click('button', 'Save mine anyway', { within: conflictDialog }), SAVED],
    } },
    { id: 'history-and-restore', who: 'anna', title: 'The change history names both, and Ben’s version comes back as a new version', steps: [
      click('button', 'More actions'), click('menuitem', 'Who changed what'), waitFor('dialog', historyDialog.name),
      see(`${anna.display}, `, { within: historyDialog }), see(`${ben.display}, `, { within: historyDialog }),
      see('Saved a change (newest)', { within: historyDialog }), see('Created it', { within: historyDialog }),
      // Newest first: Anna's save, then Ben's, whose "Restore this version" comes first.
      click('button', 'Restore this version', { within: historyDialog }),
      // The dialog closes and the editor shows Ben's version again.
      { do: 'expect-no-text', text: 'Who changed this flow' }, see(BEN_TASK),
      click('button', 'More actions'), click('menuitem', 'Who changed what'), waitFor('dialog', historyDialog.name),
      see('Brought back an older version (newest)', { within: historyDialog }),
      click('button', 'View', { exact: true, within: historyDialog }),
      see(BEN_TASK, { within: historyDialog }),
      click('button', 'Close', { exact: true, within: historyDialog }),
    ] },
    { id: 'ben-copies-into-team', who: 'ben', title: 'Ben copies an agent of his own into the team workspace, without his keys', steps: [
      goto(inOwn('/flows')), ...buildAgent(people.benFlow, 'Remember what Ben asked.'),
      goto(inOwn('/flows')), click('button', `Copy to a team workspace: ${people.benFlow}`),
      waitFor('dialog', copyDialog),
      see('Keys, passwords and sign-ins are not copied.', { within: { role: 'dialog', name: copyDialog } }),
      { do: 'select', label: 'Copy into', option: workspace, within: { role: 'dialog', name: copyDialog } },
      click('button', 'Copy', { exact: true, within: { role: 'dialog', name: copyDialog } }),
      see(`as “${people.benFlow}” into ${workspace}.`, { within: { role: 'dialog', name: copyDialog } }),
      click('button', 'Done', { exact: true, within: { role: 'dialog', name: copyDialog } }),
      goto(inTeam('/flows')), waitFor('article', people.benFlow, { exact: true }),
    ] },
    { id: 'anna-removes-ben', who: 'anna', title: 'Anna removes Ben from the team; his next visit to the team workspace is refused', steps: [
      goto('/settings'), click('button', 'Users and sign-in'), waitFor('region', `Team ${team}`, { exact: true }),
      click('button', `Remove ${ben.name} from ${team}`, { within: teamSection }),
      click('button', 'Yes, remove', { within: teamSection }),
    ] },
    { id: 'ben-is-cut-off', who: 'ben', title: 'Ben no longer reaches the team workspace', steps: [
      { do: 'goto', route: inTeam('/flows'), deadEnd: true }, see(`Unknown workspace: ${workspace}`),
    ] },
    { id: 'anna-turns-off-sign-in', who: 'anna', title: 'Anna turns sign-in for several people off again', steps: [
      goto('/settings'), click('button', 'Users and sign-in'), click('button', 'Turn off sign-in for several people'), click('button', 'Yes, turn it off'),
      see('Sign-in is off'),
    ] },
  ];
}

async function newPerson(browser, viewport, report, who) {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.problems.push(`${who}: page error: ${error.message.split('\n')[0]}`));
  page.on('console', (message) => { if (message.type() === 'error') report.problems.push(`${who}: console error: ${message.text().slice(0, 300)}`); });
  return { context, page };
}

async function runSteps(page, steps, baseUrl, where) {
  for (const [index, step] of steps.entries()) {
    try {
      await runStep(page, step, baseUrl, () => {});
    } catch (error) {
      throw new Error(`${where} step ${index + 1} (${step.do} ${step.name ?? step.label ?? step.text ?? step.route ?? ''}): ${String(error.message).split('\n')[0]}`);
    }
  }
}

/** The team journey in two browsers on one fresh FLUJO. */
export async function runTeamJourney({ baseUrl, viewport, log, report, people = journeyPeople() }) {
  const browser = await loadChromium();
  try {
    const persons = { anna: await newPerson(browser, viewport, report, 'Anna'), ben: await newPerson(browser, viewport, report, 'Ben') };
    for (const stage of teamStages(people)) {
      const started = Date.now();
      try {
        if (stage.who === 'both') {
          const { anna, ben, annaAfter = [] } = stage.steps;
          if (stage.id === 'conflict') {
            await runSteps(persons.ben.page, ben, baseUrl, 'Ben');
            await runSteps(persons.anna.page, anna, baseUrl, 'Anna');
          } else {
            await runSteps(persons.anna.page, anna, baseUrl, 'Anna');
            await runSteps(persons.ben.page, ben, baseUrl, 'Ben');
            await runSteps(persons.anna.page, annaAfter, baseUrl, 'Anna');
          }
        } else await runSteps(persons[stage.who].page, stage.steps, baseUrl, stage.who === 'anna' ? 'Anna' : 'Ben');
        for (const who of stage.who === 'both' ? ['anna', 'ben'] : [stage.who]) {
          await save(persons[who].page, 'shot', path.join(EVIDENCE, 'team', `${stage.id}-${who}.png`), () => {});
          await save(persons[who].page, 'aria', path.join(EVIDENCE, 'team', `${stage.id}-${who}.yml`), () => {});
        }
        report.team.push({ id: stage.id, ok: true, seconds: (Date.now() - started) / 1000 });
        log(`✓ ${stage.title}`);
      } catch (error) {
        report.team.push({ id: stage.id, ok: false, seconds: (Date.now() - started) / 1000, error: error.message.split('\n')[0] });
        log(`✗ ${stage.title}: ${error.message.split('\n')[0]}`);
        for (const who of ['anna', 'ben']) {
          await save(persons[who].page, 'shot', path.join(EVIDENCE, 'team', `${stage.id}-failed-${who}.png`), () => {}).catch(() => undefined);
          await save(persons[who].page, 'aria', path.join(EVIDENCE, 'team', `${stage.id}-failed-${who}.yml`), () => {}).catch(() => undefined);
        }
        return false;
      }
    }
    return true;
  } finally {
    await browser.close();
  }
}

export async function runJourney({ viewport, log = console.log, start = startProductionFlujo }) {
  const evidenceDir = path.join(EVIDENCE_DIR, EVIDENCE);
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), viewport, isolation: undefined, team: [], problems: [] };
  let isolationOk = false;
  let teamOk = false;
  try {
    log('Part 1: two people, each in a private workspace (scripts/check-multi-user.mjs)');
    const first = await start({ logFile: path.join(evidenceDir, 'flujo-isolation.log'), log });
    try {
      const summary = await checkMultiUser({ url: first.baseUrl, browserSteps: path.join(evidenceDir, 'step-files') });
      report.isolation = { ok: summary.ok, checks: summary.checks, failed: summary.failed };
      isolationOk = summary.ok;
      log(`${summary.ok ? '✓' : '✗'} ${summary.checks - summary.failed.length} of ${summary.checks} isolation and team checks passed`);
      for (const failed of summary.failed) log(`  ✗ ${failed.name}: ${JSON.stringify(failed.detail).slice(0, 300)}`);
    } finally {
      await first.stop();
    }
    log('\nPart 2: a team in two browsers at once');
    const second = await start({ logFile: path.join(evidenceDir, 'flujo-team.log'), log });
    try {
      teamOk = await runTeamJourney({ baseUrl: second.baseUrl, viewport, log, report });
    } finally {
      await second.stop();
    }
  } catch (error) {
    report.problems.push(`The run stopped: ${String(error.message ?? error).split('\n')[0]}`);
    log(`✗ The run stopped: ${error.message}`);
  }
  const pageErrors = report.problems.filter((problem) => problem.includes('page error:'));
  const passed = isolationOk && teamOk && pageErrors.length === 0 && !report.problems.some((problem) => problem.startsWith('The run stopped'));
  if (pageErrors.length) log(`✗ ${pageErrors.length} error(s) crashed code on the page: ${pageErrors[0]}`);
  writeFileSync(path.join(evidenceDir, 'report.json'), `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed }, null, 2)}\n`);
  log(`\n${passed ? 'Several people on one FLUJO: every check passed.' : 'Several people on one FLUJO: some checks failed.'} Report: ${evidenceDir}`);
  return passed ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), log = console.log, { start } = {}) {
  const { options } = parseArgs(['run', ...argv]);
  if (options.help) {
    log(USAGE);
    return 0;
  }
  return runJourney({ viewport: parseViewport(options.viewport ?? '1600x900'), log, ...(start ? { start } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
