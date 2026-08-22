#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveExperimentModule(request, parent, isMain, options) {
  const resolvedRequest = request.startsWith('@/')
    ? path.join(repoRoot, 'src', request.slice(2))
    : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

require.extensions['.ts'] = function transpileExperimentTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2020,
    },
  });
  module._compile(output.outputText, filename);
};

const {
  createMemoryExperimentVariant,
  runMemoryExperiment,
} = require('../src/backend/services/enduringAgents/memoryExperimentHarness.ts');
const {
  CURRENT_MEMORY_VARIANT,
} = require('../src/backend/services/enduringAgents/memoryRanking.ts');

function fail(message) {
  throw new Error(message);
}

function repositoryJsonPath(input, label) {
  const resolved = path.resolve(repoRoot, input);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
    fail(`${label} must stay inside the repository.`);
  }
  if (path.extname(resolved).toLowerCase() !== '.json') {
    fail(`${label} must be a JSON file.`);
  }
  if (!fs.statSync(resolved).isFile()) fail(`${label} is not a file.`);
  return resolved;
}

function parseArgs(argv) {
  const parsed = {
    fixture: '__tests__/fixtures/memory-ranking/golden-v1.json',
    variants: [],
    json: false,
    jsonPath: null,
    commit: null,
    requireNoRegressions: false,
  };
  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    else if (arg.startsWith('--json=')) parsed.jsonPath = arg.slice('--json='.length);
    else if (arg.startsWith('--fixture=')) parsed.fixture = arg.slice('--fixture='.length);
    else if (arg.startsWith('--variant=')) parsed.variants.push(arg.slice('--variant='.length));
    else if (arg.startsWith('--commit=')) parsed.commit = arg.slice('--commit='.length);
    else if (arg === '--require-no-regressions') parsed.requireNoRegressions = true;
    else fail(`Unknown argument ${JSON.stringify(arg)}.`);
  }
  return parsed;
}

function loadJson(input, label) {
  const filename = repositoryJsonPath(input, label);
  const bytes = fs.readFileSync(filename);
  return {
    filename,
    value: JSON.parse(bytes.toString('utf8')),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function baselinePassed(result) {
  return (
    result.queryOutcomes.every((outcome) => (
      outcome.hit
      && (outcome.exactOrderMatch === null || outcome.exactOrderMatch)
    ))
    && result.duplicateOutcomes.every((outcome) => outcome.correct)
  );
}

function metricRegressed(baseline, variant, key) {
  const base = baseline.metrics[key].value;
  const candidate = variant.metrics[key].value;
  return base !== null && (candidate === null || candidate < base);
}

function formatMetric(metric) {
  return metric.value === null
    ? `n/a (${metric.numerator}/${metric.denominator})`
    : `${(metric.value * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadJson(args.fixture, 'fixture');
  const variants = [
    CURRENT_MEMORY_VARIANT,
    ...args.variants.map((input) => {
      const loaded = loadJson(input, 'variant');
      return createMemoryExperimentVariant(loaded.value);
    }),
  ];
  const results = runMemoryExperiment(fixture.value, variants);
  const report = {
    schemaVersion: 1,
    fixture: {
      path: path.relative(repoRoot, fixture.filename).split(path.sep).join('/'),
      version: fixture.value.version,
      sha256: fixture.sha256,
    },
    repositoryCommit: args.commit,
    deterministic: true,
    results,
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';

  if (args.jsonPath) {
    const output = path.resolve(repoRoot, args.jsonPath);
    if (output !== repoRoot && !output.startsWith(repoRoot + path.sep)) {
      fail('JSON output must stay inside the repository.');
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized);
  }

  if (args.json) {
    process.stdout.write(serialized);
  } else {
    for (const result of results) {
      process.stdout.write(
        [
          result.variantId,
          `recall hits ${formatMetric(result.metrics.recallHitRate)}`,
          `ranking ${formatMetric(result.metrics.rankingAccuracy)}`,
          `duplicate precision ${formatMetric(result.metrics.duplicateMergePrecision)}`,
          `duplicate recall ${formatMetric(result.metrics.duplicateRecall)}`,
        ].join(' | ') + '\n',
      );
    }
    if (args.jsonPath) {
      process.stdout.write(`Wrote ${path.relative(repoRoot, path.resolve(repoRoot, args.jsonPath))}.\n`);
    }
  }

  const baseline = results[0];
  if (!baselinePassed(baseline)) {
    process.stderr.write('The checked-in baseline does not satisfy its golden expectations.\n');
    process.exitCode = 1;
    return;
  }

  if (args.requireNoRegressions) {
    const metricKeys = [
      'recallHitRate',
      'rankingAccuracy',
      'duplicateMergePrecision',
      'duplicateRecall',
    ];
    const regression = results.slice(1).some((variant) => (
      metricKeys.some((key) => metricRegressed(baseline, variant, key))
    ));
    if (regression) {
      process.stderr.write('At least one variant regressed a baseline metric.\n');
      process.exitCode = 1;
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Memory experiment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
