import { execFileSync } from 'node:child_process';
import path from 'node:path';

it('enforces exact-commit Persona evidence provenance', () => {
  expect(() => execFileSync(process.execPath, [
    '--test', path.join(process.cwd(), 'scripts/persona-acceptance-source.test.mjs'),
    path.join(process.cwd(), 'scripts/persona-soak-numeric-evidence.test.mjs'),
    path.join(process.cwd(), 'scripts/persona-goal-acceptance/endurance-data-root.test.cjs'),
    path.join(process.cwd(), 'scripts/persona-browser-acceptance/evidence.test.mjs'),
  ], { timeout: 30_000, stdio: 'pipe', windowsHide: true })).not.toThrow();
});
