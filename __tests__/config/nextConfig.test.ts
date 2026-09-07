import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import ts from 'typescript';

const execFileAsync = promisify(execFile);

describe('Next request proxy configuration', () => {
  it("keeps large chat JSON bodies above Next's 10 MiB truncation default", async () => {
    const script = [
      "import config from './next.config.mjs';",
      'process.stdout.write(JSON.stringify(config.experimental?.proxyClientMaxBodySize));',
    ].join(' ');
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
    });

    expect(JSON.parse(stdout)).toBe('100mb');
  });
});

describe('production TypeScript scope', () => {
  it('checks application code without pulling test roots into the production build', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e',
      "import config from './next.config.mjs'; process.stdout.write(JSON.stringify(config.typescript));",
    ], { cwd: process.cwd() });
    const nextTypeScript = JSON.parse(stdout);
    expect(nextTypeScript.ignoreBuildErrors).not.toBe(true);
    const readConfig = (file: string) => {
      const result = ts.readConfigFile(path.resolve(file), ts.sys.readFile);
      expect(result.error).toBeUndefined();
      return ts.parseJsonConfigFileContent(result.config, ts.sys, process.cwd());
    };
    const build = readConfig(nextTypeScript.tsconfigPath);
    const full = readConfig('tsconfig.json');
    const normalized = build.fileNames.map(file => file.replaceAll('\\', '/'));
    expect(build.errors).toEqual([]);
    expect(normalized.some(file => file.endsWith('/src/app/page.tsx'))).toBe(true);
    expect(normalized.some(file => file.endsWith('/src/proxy.ts'))).toBe(true);
    expect(normalized.some(file => /\/__tests__\/|\.(test|spec)\.[^/]+$/.test(file))).toBe(false);
    expect(full.fileNames.some(file => file.replaceAll('\\', '/').endsWith('/__tests__/config/nextConfig.test.ts'))).toBe(true);
    expect(build.options.strict).toBe(true);
    expect(build.options.noEmit).toBe(true);
  });
});
