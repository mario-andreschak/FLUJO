/** @jest-environment node */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const source = readFileSync(path.join(process.cwd(), 'src/frontend/components/Personas/taskDeadline.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

it.each(['America/Bogota', 'America/New_York', 'America/Los_Angeles', 'UTC', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Kiritimati'])('round-trips saved local Task dates in %s, including DST and month boundaries', (timeZone) => {
  const runner = compiled + `
    const dates = ['2030-07-19', '2026-01-31', '2026-03-08', '2026-11-01'];
    console.log(JSON.stringify({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dates: dates.map(input => {
        const saved = new Date(input + 'T23:59:59').getTime();
        return { input, reopened: exports.taskDeadlineInputValue(saved), savedISO: new Date(saved).toISOString() };
      })
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', runner], { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' });
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout) as { timeZone: string; dates: { input: string; reopened: string }[] };
  expect(result.timeZone).toBe(timeZone);
  for (const record of result.dates) expect(record.reopened).toBe(record.input);
});
