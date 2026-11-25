#!/usr/bin/env node
// Weekly look at the pilot sheets from docs/pilots/product-fit/start-here.md.
// Reads only the files you name and prints a summary; it writes and sends nothing.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const WEEKLY_COLUMNS = ['week', 'tester', 'report_received', 'used_flujo', 'finished_workflows',
  'failed_workflows', 'used_connected_app', 'benefit', 'help_given', 'problem_codes', 'issue_numbers',
  'flujo_version', 'install_method', 'stopped', 'stop_reason'];
export const FIRST_RUN_COLUMNS = ['tester', 'date', 'minutes', 'finished', 'stopped_at', 'help_given',
  'new_to_flujo', 'problem_codes'];
export const PROBLEM_CODES = ['installation', 'prerequisite', 'authentication', 'quota', 'discovery', 'tool-form',
  'tool-call', 'model-binding', 'runtime', 'approval', 'debugger', 'proxy', 'accessibility', 'unclear-next-step', 'other'];
const BENEFITS = ['time-saved', 'better-control', 'connection-reuse', 'none', 'unmeasured'];
const REAL_BENEFITS = new Set(['time-saved', 'better-control', 'connection-reuse']);
const STOP_REASONS = ['no-time', 'setup-failed', 'not-useful', 'other-tool', 'privacy', 'cost', 'other'];
const STOPPED_AT = ['install', 'model', 'connect', 'inspect', 'tool-test', 'agent'];
const FIRST_RUN_TARGET_MINUTES = 15;

/** Splits CSV text into rows of cells. Handles quotes, doubled quotes, CRLF and a leading BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.trim()));
}

const yes = value => value === 'yes';
const count = value => (/^\d+$/.test(value) ? Number(value) : NaN);
const codes = value => value.split(';').map(code => code.trim()).filter(Boolean);

/** Reads one sheet into objects; rows that break the column rules are reported and left out. */
export function readSheet(name, text, columns, check) {
  const [header = [], ...body] = parseCsv(text);
  const names = header.map(cell => cell.trim());
  const missing = columns.filter(column => !names.includes(column));
  if (missing.length) return { rows: [], problems: [`${name}: missing columns ${missing.join(', ')}`] };
  const rows = [];
  const problems = [];
  body.forEach((cells, index) => {
    const row = Object.fromEntries(names.map((column, at) => [column, (cells[at] ?? '').trim().toLowerCase()]));
    const wrong = check(row);
    if (wrong.length) problems.push(`${name} row ${index + 2}: ${wrong.join('; ')}`);
    else rows.push(row);
  });
  return { rows, problems };
}

const oneOf = (row, column, allowed, optional = true) =>
  (optional && !row[column]) || allowed.includes(row[column]) ? [] : [`${column} must be one of ${allowed.join(', ')}`];
const problemCodes = row => codes(row.problem_codes).filter(code => !PROBLEM_CODES.includes(code))
  .map(code => `unknown problem code "${code}"`);
const tester = row => (/^p\d{3}$/.test(row.tester) ? [] : ['tester must look like p001']);

export function checkWeekly(row) {
  return [
    ...tester(row),
    ...(Number.isInteger(count(row.week)) && count(row.week) >= 1 ? [] : ['week must be 1 or more']),
    ...oneOf(row, 'report_received', ['yes', 'no'], false),
    ...oneOf(row, 'used_flujo', ['yes', 'no']),
    ...['finished_workflows', 'failed_workflows', 'help_given']
      .filter(column => row[column] && Number.isNaN(count(row[column]))).map(column => `${column} must be a number`),
    ...oneOf(row, 'used_connected_app', ['yes', 'no']),
    ...oneOf(row, 'benefit', BENEFITS),
    ...oneOf(row, 'stopped', ['yes', 'no']),
    ...oneOf(row, 'stop_reason', STOP_REASONS),
    ...problemCodes(row),
  ];
}

export function checkFirstRun(row) {
  return [
    ...tester(row),
    ...(row.minutes && Number.isNaN(count(row.minutes)) ? ['minutes must be a whole number'] : []),
    ...oneOf(row, 'finished', ['yes', 'no'], false),
    ...oneOf(row, 'stopped_at', STOPPED_AT),
    ...oneOf(row, 'help_given', ['yes', 'no']),
    ...oneOf(row, 'new_to_flujo', ['yes', 'no']),
    ...problemCodes(row),
  ];
}

function tallyText(map) {
  const entries = [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([label, n]) => `${label} ${n}`).join(', ') : 'none';
}

function add(map, key, amount = 1) { map.set(key, (map.get(key) ?? 0) + amount); }

/** The weekly numbers from start-here.md, counted over everyone in either sheet. */
export function summarizeSheets({ weekly = [], firstRun = [] }) {
  const testers = [...new Set([...weekly, ...firstRun].map(row => row.tester))].sort();
  const lastWeek = Math.max(0, ...weekly.map(row => count(row.week)));
  const byTesterWeek = new Map(weekly.map(row => [`${row.tester}/${count(row.week)}`, row]));
  const active = row => row && yes(row.report_received) && yes(row.used_flujo) && count(row.finished_workflows) > 0;
  const stoppedIn = new Map(weekly.filter(row => yes(row.stopped)).map(row => [row.tester, count(row.week)]));
  const lines = [`Testers in the sheets: ${testers.length}`];

  for (let week = 1; week <= lastWeek; week += 1) {
    const rows = testers.map(id => byTesterWeek.get(`${id}/${week}`));
    const sum = column => rows.reduce((total, row) => total + (row && count(row[column]) > 0 ? count(row[column]) : 0), 0);
    lines.push(`Week ${week}: reports ${rows.filter(row => row && yes(row.report_received)).length} of ${testers.length}, `
      + `real use ${rows.filter(active).length}, finished ${sum('finished_workflows')}, failed ${sum('failed_workflows')}, `
      + `help given ${sum('help_given')}, stopped ${rows.filter(row => row && yes(row.stopped)).length}`);
  }
  if (lastWeek > 0) {
    const everyWeek = testers.filter(id => Array.from({ length: lastWeek }, (_, i) => byTesterWeek.get(`${id}/${i + 1}`)).every(active));
    lines.push(`Real use in every week so far (1 to ${lastWeek}): ${everyWeek.length} of ${testers.length}`);
    const benefitWeeks = new Map();
    for (const row of weekly) if (active(row) && REAL_BENEFITS.has(row.benefit)) add(benefitWeeks, row.tester);
    lines.push(`Testers with a real benefit in two or more weeks: ${[...benefitWeeks.values()].filter(n => n >= 2).length}`);
    const missing = testers.flatMap(id => {
      const weeks = Array.from({ length: lastWeek }, (_, i) => i + 1)
        .filter(week => week <= (stoppedIn.get(id) ?? lastWeek) && !yes(byTesterWeek.get(`${id}/${week}`)?.report_received ?? ''));
      return weeks.length ? [`${id} (week${weeks.length > 1 ? 's' : ''} ${weeks.join(', ')})`] : [];
    });
    lines.push(`Missing reports: ${missing.length ? missing.join('; ') : 'none'}`);
  }

  const problems = new Map();
  for (const row of [...weekly, ...firstRun]) for (const code of codes(row.problem_codes)) add(problems, code);
  lines.push(`Problems: ${tallyText(problems)}`);
  const repeated = [...problems].filter(([, n]) => n > 1).map(([code]) => code).sort();
  if (repeated.length) lines.push(`Fix first (seen more than once): ${repeated.join(', ')}`);
  const issues = [...new Set(weekly.flatMap(row => codes(row.issue_numbers)))].sort((a, b) => Number(a.replace('#', '')) - Number(b.replace('#', '')));
  lines.push(`Issues filed: ${issues.length ? issues.map(issue => `#${issue.replace('#', '')}`).join(', ') : 'none'}`);
  const stopped = weekly.filter(row => yes(row.stopped)).map(row => `${row.tester} (week ${count(row.week)}, ${row.stop_reason || 'no reason given'})`);
  lines.push(`Stopped: ${stopped.length ? stopped.join('; ') : 'none'}`);

  if (firstRun.length) {
    const novices = firstRun.filter(row => yes(row.new_to_flujo));
    const fast = novices.filter(row => yes(row.finished) && !yes(row.help_given)
      && count(row.minutes) <= FIRST_RUN_TARGET_MINUTES);
    const stoppedAt = new Map();
    for (const row of firstRun) if (!yes(row.finished)) add(stoppedAt, row.stopped_at || 'not recorded');
    lines.push(`First runs: ${firstRun.length}, finished ${firstRun.filter(row => yes(row.finished)).length}; `
      + `new testers finished within ${FIRST_RUN_TARGET_MINUTES} minutes without help: ${fast.length} of ${novices.length}; `
      + `stopped at: ${tallyText(stoppedAt)}`);
  }
  return lines;
}

async function main(argv) {
  const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const weeklyPath = option('--weekly');
  const firstRunPath = option('--first-run');
  if (!weeklyPath && !firstRunPath) {
    console.error('Usage: node scripts/product-fit-pilot/sheets.mjs --weekly <tracking-sheet.csv> [--first-run <first-run-sheet.csv>]');
    return 2;
  }
  const weekly = weeklyPath ? readSheet('tracking sheet', await readFile(weeklyPath, 'utf8'), WEEKLY_COLUMNS, checkWeekly) : { rows: [], problems: [] };
  const firstRun = firstRunPath ? readSheet('first-run sheet', await readFile(firstRunPath, 'utf8'), FIRST_RUN_COLUMNS, checkFirstRun) : { rows: [], problems: [] };
  for (const line of summarizeSheets({ weekly: weekly.rows, firstRun: firstRun.rows })) console.log(line);
  const problems = [...weekly.problems, ...firstRun.problems];
  if (problems.length) {
    console.log(`\nLeft out ${problems.length} row(s); fix them in the sheet:`);
    for (const problem of problems) console.log(`- ${problem}`);
  }
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
