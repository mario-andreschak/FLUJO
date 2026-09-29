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

describe('optional execution adapter resolution', () => {
  const resolverScript = `
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import config from './next.config.mjs';
    const require = createRequire(import.meta.url);
    const { webpack } = require('next/dist/compiled/webpack/webpack');
    const { JsConfigPathsPlugin } = require('next/dist/build/webpack/plugins/jsconfig-paths-plugin');
    const root = process.cwd();
    const results = [];
    for (const context of [
      { issuer: 'src/proxy.ts', isServer: true, nextRuntime: 'edge' },
      { issuer: 'src/app/v1/chat/completions/route.ts', isServer: true, nextRuntime: 'nodejs' },
      { issuer: 'src/app/page.tsx', isServer: false },
    ]) {
      const options = config.webpack({
        mode: 'none', context: root, entry: {},
        resolve: {
          extensions: ['.ts', '.js'],
          alias: {},
          plugins: [new JsConfigPathsPlugin({ '@/*': ['./src/*'] }, { baseUrl: root, isImplicit: true })],
        },
      }, { ...context, dev: false });
      const compiler = webpack(options);
      try {
        for (const request of [
          '@/backend/execution/extensions/configuredAdapter',
          '@/backend/execution/extensions/configuredAdapter.ts',
        ]) {
          const resolved = await new Promise((resolve, reject) =>
            compiler.resolverFactory.get('normal').resolve({}, path.dirname(path.join(root, context.issuer)),
              request, {}, (error, result) => error ? reject(error) : resolve(result)));
          results.push({ issuer: context.issuer, resolved });
        }
      } finally {
        await new Promise(resolve => compiler.close(resolve));
      }
    }
    process.stdout.write(JSON.stringify(results));
  `;

  it('selects the configured adapter after Next rewrites paths for proxy, route and client compilers', async () => {
    // Resolution only: this existing file is never loaded as an adapter.
    const selected = path.resolve('__tests__/config/nextConfig.test.ts');
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', resolverScript], {
      cwd: process.cwd(),
      env: { ...process.env, FLUJO_EXECUTION_ADAPTER_MODULE: selected },
    });
    const results = JSON.parse(stdout) as Array<{ issuer: string; resolved: string }>;
    expect(results).toHaveLength(6);
    expect(results.every(result => result.resolved === selected)).toBe(true);
  });

  it('keeps the default adapter when no integration is selected', async () => {
    const env = { ...process.env };
    delete env.FLUJO_EXECUTION_ADAPTER_MODULE;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', resolverScript], {
      cwd: process.cwd(), env,
    });
    const results = JSON.parse(stdout) as Array<{ issuer: string; resolved: string }>;
    const defaultAdapter = path.resolve('src/backend/execution/extensions/configuredAdapter.ts');
    expect(results).toHaveLength(6);
    expect(results.every(result => result.resolved === defaultAdapter)).toBe(true);
  });

  it('fails configuration when the requested integration module does not exist', async () => {
    const script = `
      import config from './next.config.mjs';
      let rejected = false;
      try { config.webpack({}, { dev: false, isServer: true }); }
      catch { rejected = true; }
      process.stdout.write(JSON.stringify({ rejected }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, FLUJO_EXECUTION_ADAPTER_MODULE: path.resolve('missing-execution-adapter.ts') },
    });
    expect(JSON.parse(stdout)).toEqual({ rejected: true });
  });
});
