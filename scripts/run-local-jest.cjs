const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertLocalTestDependencies } = require('./local-test-dependencies.cjs');

const root = path.resolve(__dirname, '..');

// Keep in sync with EXCLUDE_ISOLATED_SUITES_ENV in jest.testMatch.mjs. This
// file is CommonJS and runs before any ESM resolution, so it cannot import it.
const EXCLUDE_ISOLATED_SUITES_ENV = 'FLUJO_JEST_EXCLUDE_ISOLATED_SUITES';
const EXCLUDE_ISOLATED_SUITES_FLAG = '--exclude-isolated-suites';

function jestArgsFromNpm(argv, env) {
  const args = [...argv];
  const hasRunInBand = args.some((arg) => arg === '--runInBand' || arg === '--run-in-band');

  // When npm is invoked through npm.ps1, PowerShell consumes the standalone
  // `--` separator. npm then exposes the unknown Jest option as config instead
  // of forwarding it. Preserve the runner's serial-test contract on Windows.
  if (!hasRunInBand && /^(?:1|true|yes|on)$/i.test(env.npm_config_runinband ?? '')) {
    args.unshift('--runInBand');
  }
  return args;
}

/**
 * Split runner-only flags out of the argv before Jest sees them (issue #457).
 *
 * `--exclude-isolated-suites` drops the child-process suites from the run.
 * It is expressed as an environment variable for jest.config.mjs because npm
 * scripts cannot portably set one inline on Windows, and as a flag here so the
 * package.json script stays readable.
 */
function partitionRunnerFlags(argv) {
  const jestArgs = [];
  const env = {};
  for (const arg of argv) {
    if (arg === EXCLUDE_ISOLATED_SUITES_FLAG) {
      env[EXCLUDE_ISOLATED_SUITES_ENV] = '1';
      continue;
    }
    jestArgs.push(arg);
  }
  return { jestArgs, env };
}

function withoutForeignNodeModuleBins(value, localBin) {
  const entries = (value ?? '').split(path.delimiter).filter(Boolean);
  return [
    localBin,
    ...entries.filter((entry) => {
      const normalized = path.resolve(entry);
      if (normalized === localBin) return false;
      return !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(normalized);
    }),
  ].join(path.delimiter);
}

function main() {
  let dependencies;
  try {
    dependencies = assertLocalTestDependencies(root);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const localBin = path.join(dependencies.nodeModules, '.bin');
  const { jestArgs, env: runnerEnv } = partitionRunnerFlags(
    jestArgsFromNpm(process.argv.slice(2), process.env),
  );
  const child = spawn(process.execPath, [
    dependencies.jestBin,
    ...jestArgs,
  ], {
    cwd: root,
    env: {
      ...process.env,
      ...runnerEnv,
      // Do not let a caller-provided NODE_PATH or npm-injected ancestor .bin
      // directory reintroduce the dependency leak this wrapper is preventing.
      NODE_PATH: '',
      PATH: withoutForeignNodeModuleBins(process.env.PATH, localBin),
    },
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }

  child.on('error', (error) => {
    process.stderr.write(`Could not launch the local Jest binary: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`Local Jest exited after signal ${signal}.\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

module.exports = {
  EXCLUDE_ISOLATED_SUITES_ENV,
  EXCLUDE_ISOLATED_SUITES_FLAG,
  jestArgsFromNpm,
  partitionRunnerFlags,
  withoutForeignNodeModuleBins,
};

if (require.main === module) main();
