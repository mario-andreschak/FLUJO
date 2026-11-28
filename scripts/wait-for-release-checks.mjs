// Wait until the named workflows have finished on one commit, so the release
// evidence sees their results (#578). It never fails the release job: a
// workflow that never started or is still running after the time limit is
// shown on the evidence page as "Missing" or unfinished, and the page is still
// written.
//
//   node scripts/wait-for-release-checks.mjs --commit <sha> --workflow verify-full.yml --workflow scorecard-source.yml
//     [--limit-minutes 240] [--start-minutes 15]
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { REPOSITORY } from './npm-release.mjs';

const SHA = /^[a-f0-9]{40}$/;

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}

/** "none", "running" or "done" for one workflow on one commit. A failed look counts as "running" and is asked again. */
export async function workflowState({ workflow, commit, repository = REPOSITORY, run = runFile }) {
  try {
    const out = await run('gh', ['run', 'list', '--repo', repository, '--workflow', workflow, '--commit', commit,
      '--json', 'status', '--jq', 'map(.status)']);
    const statuses = JSON.parse(out || '[]');
    if (statuses.length === 0) return 'none';
    return statuses.every((status) => status === 'completed') ? 'done' : 'running';
  } catch {
    return 'running';
  }
}

/**
 * Poll every minute until each workflow is done, has not started within
 * `startMinutes`, or `limitMinutes` have passed. Returns the last state of each.
 */
export async function waitForChecks({
  commit, workflows, limitMinutes = 240, startMinutes = 15, pollMs = 60_000,
  now = () => Date.now(), wait = (ms) => delay(ms), state = workflowState, log = console.log,
}) {
  if (!SHA.test(commit ?? '')) throw new Error('--commit must be a full 40-character commit.');
  if (!workflows.length) throw new Error('Name at least one --workflow.');
  const started = now();
  const result = {};
  for (const workflow of workflows) {
    for (;;) {
      const current = await state({ workflow, commit });
      const minutes = (now() - started) / 60_000;
      result[workflow] = current;
      if (current === 'done') { log(`${workflow} finished on ${commit.slice(0, 8)}.`); break; }
      if (current === 'none' && minutes >= startMinutes) { log(`${workflow} never started on ${commit.slice(0, 8)}; the evidence page will show it as missing.`); break; }
      if (minutes >= limitMinutes) { log(`${workflow} is still running after ${limitMinutes} minutes; the evidence page will show it as unfinished.`); break; }
      await wait(pollMs);
    }
  }
  return result;
}

function parseArguments(argv) {
  const options = { workflows: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    if (flag === '--commit') options.commit = value;
    else if (flag === '--workflow') options.workflows.push(value);
    else if (flag === '--limit-minutes') options.limitMinutes = Number(value);
    else if (flag === '--start-minutes') options.startMinutes = Number(value);
    else throw new Error(`Unknown option ${flag}.`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  waitForChecks(parseArguments(process.argv.slice(2))).then(() => { process.exitCode = 0; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
