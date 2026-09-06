'use strict';

// Observes real Chromium child launches made by Node processes from the general
// terminal. It does not launch a browser or substitute any browser API.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const auditPath = process.env.FLUJO_GOAL_BROWSER_AUDIT;
// Capture the fixture boundary before model-authored code runs. A model may
// legitimately choose another local install path or change its browser env.
const fixtureRoot = process.env.FLUJO_GOAL_FIXTURE_ROOT;
const originalSpawn = childProcess.spawn;
childProcess.spawn = function observedSpawn(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (auditPath && fixtureRoot && /(?:chrome(?:-headless-shell)?|headless_shell|chromium)(?:\.exe)?$/i.test(String(command))) {
    child.once('spawn', () => {
      try {
        const executable = fs.realpathSync(String(command));
        const canonicalFixtureRoot = fs.realpathSync(fixtureRoot);
        const relative = path.relative(canonicalFixtureRoot, executable);
        const stat = fs.statSync(executable);
        fs.appendFileSync(auditPath, `${JSON.stringify({
          type: 'browser_spawn', at: Date.now(), executable, args, pid: child.pid,
          parentPid: process.pid, bytes: stat.size, fixtureRoot: canonicalFixtureRoot,
          selectedBrowserDirectory: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
          insideFixtureDirectory: relative !== '' && relative !== '..'
            && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        })}\n`);
      } catch { /* Missing evidence fails verification; never fabricate a launch. */ }
    });
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
