/* eslint-disable @typescript-eslint/no-require-imports -- Node bootstrap script must run before ESM/Jest resolution. */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertLocalTestDependencies } = require('./local-test-dependencies.cjs');

const root = path.resolve(__dirname, '..');

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
  const child = spawn(process.execPath, [
    dependencies.jestBin,
    ...jestArgsFromNpm(process.argv.slice(2), process.env),
  ], {
    cwd: root,
    env: {
      ...process.env,
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
  jestArgsFromNpm,
  withoutForeignNodeModuleBins,
};

if (require.main === module) main();
