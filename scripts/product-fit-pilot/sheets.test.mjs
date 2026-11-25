import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  FIRST_RUN_COLUMNS, WEEKLY_COLUMNS, checkFirstRun, checkWeekly, parseCsv, readSheet, summarizeSheets,
} from './sheets.mjs';

const header = WEEKLY_COLUMNS.join(',');
const week = (fields) => WEEKLY_COLUMNS.map(column => fields[column] ?? '').join(',');
const base = { report_received: 'yes', used_flujo: 'yes', finished_workflows: '2', failed_workflows: '0',
  used_connected_app: 'yes', benefit: 'time-saved', help_given: '0', stopped: 'no' };

const weeklyCsv = [
  header,
  week({ ...base, week: '1', tester: 'p001' }),
  week({ ...base, week: '2', tester: 'p001', benefit: 'better-control', problem_codes: 'tool-call', issue_numbers: '1450' }),
  week({ ...base, week: '1', tester: 'p002', finished_workflows: '0', failed_workflows: '1', benefit: 'none', problem_codes: 'tool-call;installation', help_given: '2' }),
  week({ week: '2', tester: 'p002', report_received: 'yes', used_flujo: 'no', stopped: 'yes', stop_reason: 'setup-failed' }),
  week({ week: '1', tester: 'p003', report_received: 'no' }),
  week({ ...base, week: '2', tester: 'p003', benefit: 'unmeasured' }),
].join('\r\n');

const firstRunCsv = [
  FIRST_RUN_COLUMNS.join(','),
  'p001,2026-12-01,12,yes,,no,yes,',
  'p002,2026-12-01,40,no,connect,yes,yes,installation',
  'p003,2026-12-02,9,yes,,no,no,',
].join('\n');

test('the shipped sheets have exactly the columns the summary reads', () => {
  const weekly = parseCsv(readFileSync(new URL('../../docs/pilots/product-fit/tracking-sheet.csv', import.meta.url), 'utf8'));
  const firstRun = parseCsv(readFileSync(new URL('../../docs/pilots/product-fit/first-run-sheet.csv', import.meta.url), 'utf8'));
  assert.deepEqual(weekly, [WEEKLY_COLUMNS]);
  assert.deepEqual(firstRun, [FIRST_RUN_COLUMNS]);
});

test('parses quoted cells, doubled quotes and blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('summarizes weekly use, benefit, problems, drop-outs and missing reports', () => {
  const weekly = readSheet('tracking sheet', weeklyCsv, WEEKLY_COLUMNS, checkWeekly);
  const firstRun = readSheet('first-run sheet', firstRunCsv, FIRST_RUN_COLUMNS, checkFirstRun);
  assert.deepEqual([...weekly.problems, ...firstRun.problems], []);

  const lines = summarizeSheets({ weekly: weekly.rows, firstRun: firstRun.rows });

  assert.deepEqual(lines, [
    'Testers in the sheets: 3',
    'Week 1: reports 2 of 3, real use 1, finished 2, failed 1, help given 2, stopped 0',
    'Week 2: reports 3 of 3, real use 2, finished 4, failed 0, help given 0, stopped 1',
    'Real use in every week so far (1 to 2): 1 of 3',
    'Testers with a real benefit in two or more weeks: 1',
    'Missing reports: p003 (week 1)',
    'Problems: installation 2, tool-call 2',
    'Fix first (seen more than once): installation, tool-call',
    'Issues filed: #1450',
    'Stopped: p002 (week 2, setup-failed)',
    'First runs: 3, finished 2; new testers finished within 15 minutes without help: 1 of 2; stopped at: connect 1',
  ]);
});

test('reports rows that break the column rules instead of counting them', () => {
  const csv = [header, week({ week: '0', tester: 'alice', report_received: 'maybe', problem_codes: 'crash' })].join('\n');

  const { rows, problems } = readSheet('tracking sheet', csv, WEEKLY_COLUMNS, checkWeekly);

  assert.equal(rows.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^tracking sheet row 2: tester must look like p001; week must be 1 or more; report_received must be one of yes, no; unknown problem code "crash"$/);
});

test('refuses a sheet with missing columns', () => {
  const { rows, problems } = readSheet('first-run sheet', 'tester,date\np001,2026-12-01', FIRST_RUN_COLUMNS, checkFirstRun);
  assert.equal(rows.length, 0);
  assert.match(problems[0], /missing columns minutes, finished/);
});
