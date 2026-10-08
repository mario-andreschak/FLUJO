import { promises as fs } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const equals = argument.indexOf('=');
    if (equals >= 0) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) values.set(key, '1');
    else {
      values.set(key, value);
      index += 1;
    }
  }
  return values;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateMemoryBenchmarkReport(report, expectedCommit, expectedRunId) {
  const errors = [];
  if (report?.schemaVersion !== 1 || typeof report?.runId !== 'string' || !report.runId) {
    errors.push('benchmark schema version or run ID is missing');
  } else if (expectedRunId && report.runId !== expectedRunId) {
    errors.push(`run ID mismatch: expected ${expectedRunId}, observed ${report.runId}`);
  }
  if (
    typeof report?.startedAt !== 'string'
    || typeof report?.endedAt !== 'string'
    || Number.isNaN(Date.parse(report.startedAt))
    || Number.isNaN(Date.parse(report.endedAt))
    || Date.parse(report.endedAt) < Date.parse(report.startedAt)
  ) {
    errors.push('benchmark timestamps are missing or invalid');
  }
  if (report?.runtime?.commit !== expectedCommit) {
    errors.push(`commit mismatch: expected ${expectedCommit}, observed ${report?.runtime?.commit}`);
  }
  if (
    report?.fixture?.version !== 'persona-memory-recall-v1'
    || report?.fixture?.hash !== '50k-release-branch-deterministic-v1'
    || report?.fixture?.itemCount !== 50_000
    || report?.fixture?.embeddingCount !== 50_000
    || !Number.isInteger(report?.fixture?.vectorDimensions)
    || report.fixture.vectorDimensions <= 0
    || typeof report?.fixture?.modelId !== 'string'
    || report.fixture.modelId.length === 0
  ) {
    errors.push('fixture identity or 50,000-item/embedding counts are invalid');
  }
  if (
    report?.runtime?.percentileMethod !== 'nearest-rank'
    || typeof report?.runtime?.node !== 'string'
    || typeof report?.runtime?.platform !== 'string'
    || typeof report?.runtime?.architecture !== 'string'
    || typeof report?.runtime?.osRelease !== 'string'
    || typeof report?.runtime?.cpuModel !== 'string'
    || !Number.isInteger(report?.runtime?.logicalCpuCount)
    || report.runtime.logicalCpuCount <= 0
    || !finiteNumber(report?.runtime?.setupMilliseconds)
    || typeof report?.runtime?.measuredOperation !== 'string'
    || typeof report?.runtime?.excluded !== 'string'
  ) {
    errors.push('runner or percentile provenance is incomplete');
  }
  if (
    report?.queryCache?.hits !== 20
    || report?.queryCache?.misses !== 1
    || report?.queryCache?.coalesced !== 0
    || report?.queryCache?.measuredHitRate !== 1
  ) {
    errors.push('warm-cache proof does not contain 20 hits after exactly one miss');
  }
  const latency = report?.latencyMilliseconds;
  if (
    latency?.sampleCount !== 20
    || !['min', 'max', 'mean', 'p50', 'p95', 'p99'].every(key => finiteNumber(latency?.[key]))
  ) {
    errors.push('latency summary is missing or malformed');
  } else {
    if (
      latency.min > latency.p50
      || latency.p50 > latency.p95
      || latency.p95 > latency.p99
      || latency.p99 > latency.max
    ) {
      errors.push('latency percentiles are not monotonic');
    }
    if (latency.p95 >= 150) {
      errors.push(`strict p95 gate failed: ${latency.p95} ms is not less than 150 ms`);
    }
  }
  if (
    report?.gate?.criterionId !== 'controlled-50k-recall-p95'
    || report?.gate?.operator !== 'strictly_less_than'
    || report?.gate?.thresholdMilliseconds !== 150
    || report?.gate?.observedMilliseconds !== latency?.p95
    || report?.gate?.status !== 'passed'
  ) {
    errors.push('strict benchmark gate record is missing or inconsistent');
  }

  if (
    report?.ranking?.lexicalWeight !== 0.6
    || report?.ranking?.semanticWeight !== 0.4
    || report?.ranking?.semanticFloor !== 0.75
  ) {
    errors.push('ranking configuration is missing or unexpected');
  }

  const quality = report?.quality;
  const lexical = quality?.goldenSet?.lexical;
  const hybrid = quality?.goldenSet?.hybrid;
  const delta = quality?.goldenSet?.delta;
  if (
    !Number.isInteger(quality?.productionPath?.lexicalReturned)
    || quality.productionPath.lexicalReturned < 0
    || typeof quality?.productionPath?.hybridTopMemoryId !== 'string'
    || typeof quality?.goldenSet?.version !== 'string'
    || quality.goldenSet.version.length === 0
    || !finiteNumber(lexical?.recallAtK)
    || !finiteNumber(lexical?.meanReciprocalRank)
    || !finiteNumber(hybrid?.recallAtK)
    || !finiteNumber(hybrid?.meanReciprocalRank)
    || !finiteNumber(delta?.recallAtK)
    || !finiteNumber(delta?.meanReciprocalRank)
    || delta.recallAtK <= 0
    || delta.meanReciprocalRank <= 0
  ) {
    errors.push('production-path or golden-set quality evidence is incomplete');
  }
  return errors;
}

export async function validateMemoryBenchmarkFile(file, expectedCommit, expectedRunId) {
  let report;
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
    report = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Benchmark report is missing or malformed: ${file} (${error.message})`);
  }
  const errors = validateMemoryBenchmarkReport(report, expectedCommit, expectedRunId);
  if (raw !== `${JSON.stringify(report, null, 2)}\n`) {
    errors.push('benchmark report is not canonical pretty-printed JSON');
  }
  if (errors.length > 0) {
    throw new Error(`Memory benchmark evidence validation failed:\n- ${errors.join('\n- ')}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const values = parseArguments(process.argv.slice(2));
  const file = path.resolve(
    values.get('file') ?? 'benchmark-artifacts/persona-memory-recall.json',
  );
  const expectedCommit = values.get('commit')
    ?? process.env.FLUJO_BENCHMARK_COMMIT
    ?? process.env.GITHUB_SHA;
  const expectedRunId = values.get('run-id')
    ?? process.env.FLUJO_BENCHMARK_RUN_ID
    ?? process.env.GITHUB_RUN_ID;
  if (!expectedCommit) throw new Error('Expected commit is required.');
  if (!expectedRunId) throw new Error('Expected benchmark run ID is required.');
  const report = await validateMemoryBenchmarkFile(file, expectedCommit, expectedRunId);
  process.stdout.write(
    `Validated 50k recall evidence for ${expectedCommit}: p95=${report.latencyMilliseconds.p95} ms.\n`,
  );
}
