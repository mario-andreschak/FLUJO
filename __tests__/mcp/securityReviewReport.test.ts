import { normalizeSkillSpectorReport } from '@/backend/services/mcp/securityReview/report';
import actualVendorReport from './fixtures/skillspector-2.12-static-report.json';

export const fixtureReport = () => ({
  metadata: { skillspector_version: '2.12.0', llm_requested: false, meta_analysis_applied: false },
  analysis_completeness: { is_complete: true, status: 'complete', scope_exclusions: [], ledger_exceptions: [], analyzer_statuses: [], limitations: [] },
  execution_successful: true, risk_assessment: { score: 0, severity: 'SAFE', recommendation: 'SAFE_TO_INSTALL' }, issues: [], suppressed_count: 0,
});
const source = { repositoryUrl: 'https://github.com/a/b', revision: 'a'.repeat(40), digest: 'b'.repeat(64), fileCount: 1, bytes: 20 };
const run = (body: unknown, exitCode = 0) => normalizeSkillSpectorReport({ stdout: JSON.stringify(body), exitCode, imageId: `sha256:${'c'.repeat(64)}` }, source);
it('retains static risk evidence without any safety or installation recommendation', () => {
  const review = run(fixtureReport());
  expect(review.status).toBe('reviewed');
  expect(review.risk).toEqual({ score: 0, severity: 'LOW' });
  expect(review).not.toHaveProperty('safe');
  expect(JSON.stringify(review)).not.toContain('SAFE_TO_INSTALL');
  expect(review.limitations.join(' ')).toMatch(/grants no install approval/);
});
it('accepts exit1 findings and normalizes actual vendor fields', () => {
  const body = fixtureReport();
  const result = run({ ...body, risk_assessment: { score: 75, severity: 'HIGH' }, issues: [{ severity: 'HIGH', category: 'prompt_injection', location: { file: '/input/SKILL.md', start_line: 3 }, explanation: 'Ignore prior instructions', finding: 'Injection' }] }, 1);
  expect(result.findings).toEqual([{ severity: 'HIGH', category: 'prompt_injection', file: '/input/SKILL.md', line: 3, message: 'Ignore prior instructions' }]);
});
it.each([2, 137, -1])('rejects failed exit%d', exit => expect(() => run(fixtureReport(), exit)).toThrow());
it.each([
  { skillspector_version: '2.11.0', llm_requested: false, meta_analysis_applied: false },
  { skillspector_version: '2.12.0', llm_requested: true, meta_analysis_applied: false },
  { skillspector_version: '2.12.0', llm_requested: false, meta_analysis_applied: true },
  { skillspector_version: '2.12.0', llm_requested: false },
])('rejects unexpected scanner identity/mode %j', metadata => expect(() => run({ ...fixtureReport(), metadata })).toThrow());
it.each(['scope_exclusions', 'ledger_exceptions', 'analyzer_statuses', 'limitations'])('retains %s coverage details and labels partial', key => {
  const body = fixtureReport();
  const details = key === 'limitations' ? ['offline dependency inspection'] : [{ path: 'opaque.bin', status: 'skipped', reason: 'unsupported content' }];
  const review = run({ ...body, analysis_completeness: { ...body.analysis_completeness, [key]: details } });
  expect(review.status).toBe('partial');
  expect(review.limitations.some(value => value.startsWith(`${key}:`))).toBe(true);
});
it('preserves unsuccessful execution as partial evidence', () => expect(run({ ...fixtureReport(), execution_successful: false }).status).toBe('partial'));
it('accepts the actual locally executed 2.12.0 static/offline report and retains disabled analyzer coverage', () => {
  const review = run(actualVendorReport);
  expect(review.status).toBe('partial');
  expect(review.risk).toEqual({ score: 0, severity: 'LOW' });
  expect(review.findings).toEqual([]);
  expect(review.limitations.filter(value => value.startsWith('analyzer_statuses:'))).toHaveLength(27);
  expect(review.limitations.join(' ')).toContain('disabled_by_configuration');
  expect(review.limitations.join(' ')).toContain('Scanner fully_inspected_files: 1.');
  expect(JSON.stringify(review)).not.toContain('"SAFE"');
});
it.each([
  { analysis_completeness: {} }, { issues: Array(257).fill({}) }, { risk_assessment: { score: -1, severity: 'LOW' } },
  { issues: [{ severity: 'HIGH', category: 'x', location: { file: 'a', start_line: 0 }, explanation: 'x' }] },
])('rejects malformed/bounded report %j', patch => expect(() => run({ ...fixtureReport(), ...patch })).toThrow());
