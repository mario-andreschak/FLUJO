/**
 * Tests shorten waits and limits through a few environment variables. Outside
 * tests FLUJO ignores them and keeps its built-in values (#1449), so they are
 * never settings a user has to know about.
 */
export function testSetting(name: string): string | undefined {
  return process.env.NODE_ENV === 'test' ? process.env[name] : undefined;
}
