const { removePrivateTestTemp } = require('./scripts/private-test-temp.cjs');

const STATE = Symbol.for('flujo.jest.privateTestTemp');

module.exports = async function globalTeardown() {
  const state = globalThis[STATE];
  globalThis[STATE] = undefined;
  try {
    await removePrivateTestTemp(state);
  } catch (error) {
    // A process a test left running can still hold a file; the next run removes the root.
    console.warn(`[jest] Could not remove this run's temp folder yet: ${error.message}`);
  }
};
