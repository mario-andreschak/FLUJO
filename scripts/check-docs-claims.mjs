// Docs honesty check (#578). The pages a new user reads first must show every
// experimental capability and every profile FLUJO does not support yet, keep
// listing the features the external audit graded, and make no claim that the
// release evidence cannot back ("production-ready", "secure by default", ...).
//
//   node scripts/check-docs-claims.mjs            # checks the working tree
//
// The release reassessment (scripts/release-reassessment.mjs) runs the same
// check on the files of the exact release commit.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const README = 'README.md';
export const PROJECT_STATUS = 'docs/project-status.md';
export const SECURITY = 'SECURITY.md';
export const CLAIM_FILES = Object.freeze([README, PROJECT_STATUS, SECURITY]);

/** Capabilities that are still experimental. Each must be marked so in README and project status. */
export const EXPERIMENTAL_CAPABILITIES = Object.freeze([
  { id: 'personas', name: 'Personas' },
  { id: 'meetings', name: 'Meetings' },
  { id: 'waves', name: 'Waves' },
]);

/** Ways of running FLUJO that are not supported yet. Each must be named as such in README and project status. */
export const DEFERRED_PROFILES = Object.freeze([
  {
    id: 'shared-team',
    name: 'shared or team use (several users on one FLUJO, #212)',
    subject: /multi-user|several users|team (?:use|isolation|sharing)|shared (?:or team )?use/i,
    limit: /\bnot\b|\bno\b|does not provide|do not provide|deferred|single[- ]owner|one owner/i,
  },
]);

/** Features the external audit graded (#563). Dropping one from the README is a scope cut nobody announced. */
export const AUDITED_FEATURES = Object.freeze([
  { id: 'models', name: 'model connections', pattern: /model connections|AI Setup/i },
  { id: 'mcp', name: 'MCP servers (Connected Apps)', pattern: /Connected Apps \(MCP\)/ },
  { id: 'agent-builder', name: 'visual agent builder', pattern: /Agent Builder/ },
  { id: 'debugger', name: 'debugger', pattern: /debugg/i },
  { id: 'approvals', name: 'tool approvals', pattern: /approval/i },
  { id: 'automations', name: 'automations and schedules', pattern: /Automations/ },
  { id: 'openai-api', name: 'OpenAI-compatible API', pattern: /OpenAI[- ]compatible/i },
  { id: 'mcp-proxy', name: 'MCP proxy', pattern: /MCP (?:proxy|server endpoint)|proxy/i },
]);

/** Claims no release evidence backs today. A line that negates the claim ("not production-ready") is fine. */
export const UNSUPPORTED_CLAIMS = Object.freeze([
  { id: 'production-ready', pattern: /production[- ]ready|production[- ]grade/i },
  { id: 'enterprise', pattern: /enterprise[- ](?:grade|ready)/i },
  { id: 'battle-tested', pattern: /battle[- ]tested/i },
  { id: 'secure-by-default', pattern: /secure by default/i },
  { id: 'grade-of-security', pattern: /(?:bank|military)[- ]grade/i },
  { id: 'bug-free', pattern: /bug[- ]free|zero bugs/i },
  { id: 'unattended-weeks', pattern: /fully autonomous|(?:runs?|working) unattended for (?:days|weeks|months)|weeks of unattended/i },
]);

const NEGATION = /\b(?:not|no|never|isn't|aren't|without|nor|cannot)\b/i;

const lines = (text) => String(text ?? '').split(/\r?\n/);
const mentions = (line, name) => new RegExp(`\\b${name}\\b`).test(line);

/**
 * Check the claim files. `files` maps a repository path to its text (missing
 * files are reported, not thrown). Returns one entry per problem.
 */
export function checkDocsClaims(files) {
  const problems = [];
  const text = (file) => files[file];
  for (const file of [README, PROJECT_STATUS]) {
    if (typeof text(file) !== 'string') {
      problems.push({ id: 'missing-file', file, detail: `${file} is missing.` });
      continue;
    }
    const fileLines = lines(text(file));
    for (const capability of EXPERIMENTAL_CAPABILITIES) {
      const labelled = fileLines.some((line) => mentions(line, capability.name) && /experiment/i.test(line));
      if (!labelled) {
        problems.push({
          id: `experimental-${capability.id}`, file,
          detail: `${file} never marks ${capability.name} as experimental. Add it to the status table with "Experimental".`,
        });
      }
    }
    for (const profile of DEFERRED_PROFILES) {
      const named = fileLines.some((line) => profile.subject.test(line) && profile.limit.test(line));
      if (!named) {
        problems.push({
          id: `deferred-${profile.id}`, file,
          detail: `${file} does not say that ${profile.name} is not supported yet. Add one line that names the limit.`,
        });
      }
    }
  }

  if (typeof text(README) === 'string') {
    for (const feature of AUDITED_FEATURES) {
      if (!feature.pattern.test(text(README))) {
        problems.push({
          id: `feature-${feature.id}`, file: README,
          detail: `${README} no longer mentions ${feature.name}. If it was removed, say so in the README and the changelog.`,
        });
      }
    }
  }

  for (const file of CLAIM_FILES) {
    if (typeof text(file) !== 'string') continue;
    lines(text(file)).forEach((line, index) => {
      for (const claim of UNSUPPORTED_CLAIMS) {
        if (claim.pattern.test(line) && !NEGATION.test(line)) {
          problems.push({
            id: `claim-${claim.id}`, file, line: index + 1,
            detail: `${file}:${index + 1} claims "${line.match(claim.pattern)[0]}", which no release evidence backs. Say what was checked instead.`,
          });
        }
      }
    });
  }
  return problems;
}

/** Read the claim files from a folder (default: the working tree). */
export async function readClaimFiles(root = process.cwd()) {
  const files = {};
  for (const file of new Set([README, PROJECT_STATUS, ...CLAIM_FILES])) {
    try {
      files[file] = await readFile(path.join(root, file), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

export async function main({ root = process.cwd(), log = console.log, error = console.error } = {}) {
  const problems = checkDocsClaims(await readClaimFiles(root));
  if (problems.length === 0) {
    log(`Docs claims: ${CLAIM_FILES.join(', ')} mark ${EXPERIMENTAL_CAPABILITIES.length} experimental capabilities and `
      + `${DEFERRED_PROFILES.length} unsupported profile, list all ${AUDITED_FEATURES.length} audited features and make no unsupported claim.`);
    return 0;
  }
  error(`Docs claims: ${problems.length} problem(s).`);
  for (const problem of problems) error(`- ${problem.detail}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
