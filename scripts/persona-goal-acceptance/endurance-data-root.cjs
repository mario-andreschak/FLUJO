'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only the opt-in endurance environment calls this. Ordinary Jest suites must
// never inherit FLUJO_DATA_DIR, which can point at a user's real installation.
function resolveEnduranceDataRoot(env) {
  const output = env.PERSONA_GOAL_ENDURANCE_OUTPUT;
  const root = env.FLUJO_DATA_DIR;
  const phase = env.PERSONA_GOAL_ENDURANCE_PHASE;
  if (!output || !root || !['bootstrap', 'crash-after-effect', 'recover'].includes(phase)
    || !['offline', 'live'].includes(env.PERSONA_GOAL_ENDURANCE_MODE)) {
    throw new Error('Endurance data requires an owned runner output and execution phase.');
  }
  const outputDirectory = fs.realpathSync(output);
  const dataRoot = fs.realpathSync(root);
  if (dataRoot !== path.join(outputDirectory, 'runtime-data')
    || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('Endurance data must be the runner output runtime-data directory.');
  }
  const state = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'runner-state.json'), 'utf8'));
  if (state.schemaVersion !== 1 || state.status !== 'running'
    || !state.runId || state.runId !== env.PERSONA_GOAL_ENDURANCE_RUN_ID
    || state.mode !== env.PERSONA_GOAL_ENDURANCE_MODE
    || path.resolve(state.outputDirectory) !== path.resolve(output)) {
    throw new Error('Endurance data does not belong to the active runner identity.');
  }
  return dataRoot;
}

module.exports = { resolveEnduranceDataRoot };
