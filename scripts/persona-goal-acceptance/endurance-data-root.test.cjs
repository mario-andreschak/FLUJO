const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveEnduranceDataRoot } = require('./endurance-data-root.cjs');

test('endurance processes share only the active runner-owned data directory', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-endurance-root-'));
  try {
    const root = path.join(output, 'runtime-data');
    fs.mkdirSync(root);
    const state = {
      schemaVersion: 1, status: 'running', runId: 'owned-run',
      mode: 'offline', outputDirectory: output,
    };
    fs.writeFileSync(path.join(output, 'runner-state.json'), JSON.stringify(state));
    const env = {
      FLUJO_DATA_DIR: root, PERSONA_GOAL_ENDURANCE_OUTPUT: output,
      PERSONA_GOAL_ENDURANCE_RUN_ID: 'owned-run', PERSONA_GOAL_ENDURANCE_MODE: 'offline',
      PERSONA_GOAL_ENDURANCE_PHASE: 'bootstrap',
    };
    fs.writeFileSync(path.join(resolveEnduranceDataRoot(env), 'checkpoint'), 'persisted');
    for (const phase of ['crash-after-effect', 'recover']) {
      const recovered = resolveEnduranceDataRoot({ ...env, PERSONA_GOAL_ENDURANCE_PHASE: phase });
      assert.equal(fs.readFileSync(path.join(recovered, 'checkpoint'), 'utf8'), 'persisted');
    }
    assert.throws(() => resolveEnduranceDataRoot({ FLUJO_DATA_DIR: root }), /owned runner/);
    assert.throws(() => resolveEnduranceDataRoot({ ...env, FLUJO_DATA_DIR: output }), /runtime-data/);
    assert.throws(() => resolveEnduranceDataRoot({ ...env, PERSONA_GOAL_ENDURANCE_RUN_ID: 'other' }), /identity/);
    fs.writeFileSync(path.join(output, 'runner-state.json'), JSON.stringify({ ...state, status: 'completed' }));
    assert.throws(() => resolveEnduranceDataRoot(env), /identity/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
