import type { McpSecurityReview } from '@/shared/mcpSecurityReview';

export const REVIEW_LIMITATIONS = [
  'Optional assistive review of the captured public GitHub revision only; this report grants no install approval, human trust, or host capabilities.',
  'Static analysis only: no LLM or runtime/tool execution. Offline dependency lookup cannot establish dependency vulnerability coverage.',
  'Repository source is not evidence of equivalence to a Registry package, installed dependencies, a hosted MCP endpoint, or future revisions.',
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scanner report.');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 2048): string {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Invalid scanner text.');
  return value;
}
function severity(value: unknown): string {
  const result = text(value, 32);
  if (!['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'INFO', 'UNKNOWN'].includes(result)) throw new Error('Invalid scanner severity.');
  return result;
}

/** Normalize actual SkillSpector 2.12.0 JSON. Do not import its safety recommendation. */
export function normalizeSkillSpectorReport(
  result: { stdout: string; exitCode: number; imageId: string },
  source: NonNullable<McpSecurityReview['source']>,
): McpSecurityReview {
  if (![0, 1].includes(result.exitCode) || Buffer.byteLength(result.stdout) > 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(result.imageId)) throw new Error('Scanner result is unavailable.');
  const report = object(JSON.parse(result.stdout));
  const metadata = object(report.metadata);
  if (metadata.skillspector_version !== '2.12.0' || metadata.llm_requested !== false || metadata.meta_analysis_applied !== false
    || (metadata.llm_calls_attempted !== undefined && metadata.llm_calls_attempted !== 0)) throw new Error('Unexpected scanner mode or revision.');
  const completeness = object(report.analysis_completeness);
  if (typeof report.execution_successful !== 'boolean' || typeof completeness.is_complete !== 'boolean'
    || !['complete', 'partial', 'failed'].includes(String(completeness.status))) throw new Error('Missing scanner completeness evidence.');
  const limitations = [...REVIEW_LIMITATIONS];
  let partial = !report.execution_successful || completeness.is_complete !== true || completeness.status !== 'complete';
  for (const key of ['scope_exclusions', 'ledger_exceptions', 'analyzer_statuses', 'limitations'] as const) {
    const values = completeness[key];
    if (!Array.isArray(values) || values.length > 256) throw new Error('Invalid scanner completeness details.');
    for (const value of values) {
      // Retain the vendor's bounded details rather than guessing the meaning of exclusions.
      const detail = key === 'limitations' ? text(value) : text(JSON.stringify(object(value)), 4096);
      limitations.push(`${key}: ${detail}`);
      if (key !== 'analyzer_statuses') partial = true;
      else {
        const status = object(value).status;
        if (typeof status !== 'string' || !['complete', 'completed', 'not_applicable'].includes(status)) partial = true;
      }
    }
  }
  if (!report.execution_successful) limitations.push('The scanner reported unsuccessful execution; retained findings do not establish complete analysis.');
  if (metadata.transitive_truncated === true) {
    partial = true;
    limitations.push('The scanner reported truncated transitive inspection.');
  }
  const risk = object(report.risk_assessment);
  if (typeof risk.score !== 'number' || !Number.isFinite(risk.score) || risk.score < 0 || risk.score > 100) throw new Error('Invalid scanner score.');
  if (!Array.isArray(report.issues) || report.issues.length > 256) throw new Error('Scanner findings exceed report limits.');
  const findings = report.issues.map(raw => {
    const issue = object(raw), location = object(issue.location);
    const line = location.start_line;
    if (!Number.isSafeInteger(line) || Number(line) < 1) throw new Error('Invalid scanner location.');
    return { severity: severity(issue.severity), category: text(issue.category, 128), file: text(location.file, 512),
      line: Number(line), message: text(issue.explanation || issue.finding) };
  });
  if (typeof report.suppressed_count !== 'number' || !Number.isSafeInteger(report.suppressed_count) || report.suppressed_count < 0) throw new Error('Invalid suppressed finding count.');
  if (report.suppressed_count) limitations.push(`${report.suppressed_count} scanner findings were suppressed by its heuristic filtering; displayed findings are not the full raw finding set.`);
  for (const key of ['total_components', 'scanned_components', 'fully_inspected_files', 'partially_inspected_files', 'entirely_uninspected_files', 'coverage_percent']) {
    if (completeness[key] !== undefined) {
      const count = completeness[key];
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || count > 100_000) throw new Error('Invalid scanner coverage count.');
      limitations.push(`Scanner ${key}: ${count}.`);
    }
  }
  if (Number(completeness.partially_inspected_files) > 0 || Number(completeness.entirely_uninspected_files) > 0
    || (typeof completeness.total_components === 'number' && completeness.total_components < source.fileCount)) {
    partial = true;
    limitations.push('The scanner did not fully account for every captured source file.');
  }
  if (limitations.join('').length > 64 * 1024) throw new Error('Scanner coverage details exceed report limits.');
  return { status: partial ? 'partial' : 'reviewed', message: partial ? 'Static source review returned incomplete coverage. Inspect the findings and limitations.' : 'Static source review finished. Inspect the findings and limitations.',
    source, scanner: { name: 'SkillSpector', version: '2.12.0', imageId: result.imageId, mode: 'static', dependencyLookup: 'offline' },
    risk: { score: risk.score, severity: risk.severity === 'SAFE' ? 'LOW' : severity(risk.severity) }, findings, limitations };
}
