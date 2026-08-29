import { execFile } from 'child_process';
import { promisify } from 'util';

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
