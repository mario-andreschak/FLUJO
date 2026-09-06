import type fixture from './fixture.cjs';
declare const terminalFixture: {
  createFixture: typeof fixture.createFixture;
  verifyFixture(directory: string): Promise<Awaited<ReturnType<typeof fixture.verifyFixture>> & { browserExecutionVerified: boolean; browserLaunches: unknown[]; httpRequests: unknown[]; terminalCommands: unknown[] }>;
};
export = terminalFixture;
