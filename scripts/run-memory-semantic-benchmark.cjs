process.env.FLUJO_PERF_TESTS = '1';
process.argv.push(
  '--selectProjects',
  'node',
  '--runInBand',
  '__tests__/enduringAgents/memorySemanticRecallPerf.test.ts',
);
require('./run-local-jest.cjs').main();
