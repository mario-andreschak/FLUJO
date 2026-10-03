const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertLocalTestDependencies } = require('./local-test-dependencies.cjs');
const EXPECTED_TEST_FILES_ENV = 'FLUJO_JEST_EXPECTED_TEST_FILES';

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

function selectionContract(argv, rootDir) {
  if (argv.some((arg) => /^--pass(?:WithNoTests|-with-no-tests)(?:=|$)/.test(arg))) {
    throw new Error('The local runner refuses --passWithNoTests; zero execution must fail.');
  }
  const expectedFiles = argv.filter((arg) => !arg.startsWith('-')
    && /\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(arg) && !/[*?{}()|^$]/.test(arg))
    .map((file) => path.resolve(rootDir, file));
  const diagnostic = argv.some((arg) => ['--listTests', '--showConfig', '--help', '-h', '--version', '-v'].includes(arg));
  if (diagnostic) return { args: argv, expectedFiles: [] };
  const reporter = __filename;
  const hasReporter = argv.some((arg) => arg === '--reporters' || arg.startsWith('--reporters='));
  return {
    args: [...argv, ...(hasReporter ? [] : ['--reporters=default']), `--reporters=${reporter}`],
    expectedFiles: [...new Set(expectedFiles)],
  };
}

const testIdentity = (file) => {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

function assertTestExecution(results, expectedFiles = []) {
  if (!results || !(results.numPassedTests + results.numFailedTests > 0)) {
    throw new Error('Local Jest completed no test assertions; refusing zero-execution success.');
  }
  for (const file of expectedFiles) {
    const matches = results.testResults?.filter((result) => testIdentity(result.testFilePath) === testIdentity(file)) ?? [];
    if (matches.length !== 1) throw new Error(`Explicitly selected suite did not run exactly once: ${file}`);
    if (!(matches[0].numPassingTests + matches[0].numFailingTests > 0)) {
      throw new Error(`Explicitly selected suite completed no assertions: ${file}`);
    }
  }
}

class SelectionReporter {
  constructor() {
    this.expectedFiles = JSON.parse(process.env[EXPECTED_TEST_FILES_ENV] || '[]');
    this.error = undefined;
  }

  onRunComplete(_contexts, results) {
    try { assertTestExecution(results, this.expectedFiles); } catch (error) {
      this.error = error;
      process.stderr.write(`Local Jest selection refused: ${error.message}\n`);
    }
  }

  getLastError() { return this.error; }
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
  let selection;
  try { selection = selectionContract(jestArgs, root); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [
    dependencies.jestBin,
    ...selection.args,
  ], {
    cwd: root,
    env: {
      ...process.env,
      ...runnerEnv,
      [EXPECTED_TEST_FILES_ENV]: JSON.stringify(selection.expectedFiles),
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

// Jest loads this same already-shipped file as a reporter. Named helper APIs
// remain available to existing callers, without adding a package dependency.
module.exports = SelectionReporter;
Object.assign(module.exports, {
  EXPECTED_TEST_FILES_ENV,
  EXCLUDE_ISOLATED_SUITES_ENV,
  EXCLUDE_ISOLATED_SUITES_FLAG,
  jestArgsFromNpm,
  main,
  partitionRunnerFlags,
  selectionContract,
  withoutForeignNodeModuleBins,
  assertTestExecution,
});

if (require.main === module) main();
