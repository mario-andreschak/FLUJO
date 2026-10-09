import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REQUIRED_CHECK_NAMES } from './verification-contract.mjs';

export const ACTIONS_APP_ID = 15368;

/** Inspect effective API rules plus their full rulesets; never infer enforcement from YAML. */
export function assertRepositoryRules({ rules, rulesets }) {
  if (!Array.isArray(rules) || !rules.length || !Array.isArray(rulesets)) throw new Error('No effective branch rules were proved.');
  const contributing = new Set(rules.map((rule) => rule.ruleset_id));
  for (const id of contributing) {
    const ruleset = rulesets.find((item) => item.id === id);
    if (!Number.isSafeInteger(id) || ruleset?.enforcement !== 'active'
        || !Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length) {
      throw new Error('Every contributing ruleset must be active with a visible, empty bypass list.');
    }
  }
  for (const type of ['deletion', 'non_fast_forward']) {
    if (!rules.some((rule) => rule.type === type)) throw new Error(`Missing effective ${type} rule.`);
  }
  const review = rules.some(rule => rule.type === 'pull_request'
    && rule.parameters?.required_approving_review_count === 0
    && rule.parameters.require_code_owner_review === false && rule.parameters.require_last_push_approval === false
    && rule.parameters.required_review_thread_resolution === true);
  if (!review) throw new Error('Automated merge policy must require no human approvals and resolve review threads.');
  for (const name of REQUIRED_CHECK_NAMES) {
    if (!rules.some((rule) => rule.type === 'required_status_checks'
        && rule.parameters?.strict_required_status_checks_policy === true
        && rule.parameters.do_not_enforce_on_create === false
        && rule.parameters.required_status_checks?.some((check) => check.context === name && check.integration_id === ACTIONS_APP_ID))) {
      throw new Error(`Missing required up-to-date GitHub Actions check: ${name}.`);
    }
  }
  if (rules.some(rule => rule.type === 'code_scanning' || (rule.type === 'required_status_checks' && rule.parameters.required_status_checks.some(check => !REQUIRED_CHECK_NAMES.includes(check.context))))) throw new Error('Focused merge policy cannot require former hosted contexts or a separate scanner run.');
}

export function inspectRepositoryRules({ api, branch = 'main' }) {
  if (!/^\w[\w./-]*$/.test(branch) || branch.includes('..')) throw new Error('Invalid branch name.');
  const rules = api(`repos/mario-andreschak/FLUJO/rules/branches/${encodeURIComponent(branch)}`);
  if (!Array.isArray(rules)) throw new Error('Invalid effective-rules API response.');
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id))];
  const rulesets = ids.map((id) => {
    if (!Number.isSafeInteger(id)) throw new Error('Effective rule lacks its ruleset identity.');
    return api(`repos/mario-andreschak/FLUJO/rulesets/${id}`);
  });
  assertRepositoryRules({ rules, rulesets });
  return { branch, rules, rulesets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const evidence = inspectRepositoryRules({
      branch: process.argv[2] ?? 'main',
      api: (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })),
    });
    console.log(JSON.stringify({ ...evidence, observedAt: new Date().toISOString(), status: 'configured-requires-merge-denial-drill' }, null, 2));
  } catch (error) {
    console.error(`Repository enforcement unverified: ${error.message}`);
    process.exitCode = 1;
  }
}
