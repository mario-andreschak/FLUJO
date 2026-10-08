const Sequencer = require('@jest/test-sequencer').default;

module.exports = class IsolatedTestSequencer extends Sequencer {
  sort(tests) {
    const ordered = super.sort(tests);
    const isSoak = test => /[\\/]enduringAgents[\\/]soak[\\/]personaSoak\.test\.ts$/.test(test.path);
    // The RSS contract measures the soak workload, before other integration
    // suites leave compiled modules and large fixture allocations in Jest.
    return [...ordered.filter(isSoak), ...ordered.filter(test => !isSoak(test))];
  }
};
