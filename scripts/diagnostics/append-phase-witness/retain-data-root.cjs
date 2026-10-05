'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FLUJO_APPEND_WITNESS_DATA_ROOT;
const output = process.env.FLUJO_APPEND_WITNESS_OUTPUT;
if (!root || !output || fs.realpathSync(root) !== path.join(fs.realpathSync(output), 'synthetic-temp', 'installation')) throw new Error('Explicit runner-owned synthetic installation root required');
// Retain synthetic I/O on timeout/failure. This is the existing setup's owned
// data-root hook; the actual workspace gate and lock code are still executed.
globalThis.__personaGoalEnduranceDataRoot = fs.realpathSync(root);
