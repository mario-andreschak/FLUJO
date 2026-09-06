import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CONTROLLED_PUBLIC_FIXTURE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'flujo-controlled-marketing-service',
  version: '2026-09-06',
  serviceClass: 'controlled-staging',
  approved: true,
  approvalId: 'issue-505-controlled-fixture-v1',
  baseUrl: 'allocated-at-runtime',
  account: {
    id: 'disposable-campaign-account',
    credentialReference: 'env:PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN',
  },
  allowedOperations: [
    'read_research',
    'observe_artifact',
    'publish_campaign',
    'read_publication',
    'cleanup_publication',
  ],
  effectScope: {
    publicInternet: false,
    channel: 'controlled-developer-community',
    maxPublications: 1,
    accountCreationAllowed: false,
  },
  limits: {
    maxAttempts: 20,
    maxRequestsPerMinute: 120,
    maxPayloadBytes: 131072,
  },
  retention: {
    evidenceDays: 30,
    cleanupRequired: true,
    preserveFailedRuns: true,
  },
  faultSchedule: [
    'rate-limit-once',
    'commit-then-withhold-acknowledgement-once',
  ],
});

function isCredentialReference(value) {
  return typeof value === 'string'
    && /^(?:env|secret|vault):[A-Z0-9_./:-]+$/i.test(value);
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...expected].sort().join('|');
}

function hasExactValues(value, expected) {
  return Array.isArray(value)
    && [...value].sort().join('|') === [...expected].sort().join('|');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stableValue(value[key])]));
}

export function validatePublicFixtureManifest(
  manifest,
  { allowGenuinePublic = false, operatorApproval } = {},
) {
  const errors = [];
  const assert = (condition, message) => {
    if (!condition) errors.push(message);
  };
  assert(hasExactKeys(manifest, [
    'schemaVersion',
    'id',
    'version',
    'serviceClass',
    'approved',
    'approvalId',
    'baseUrl',
    'account',
    'allowedOperations',
    'effectScope',
    'limits',
    'retention',
    'faultSchedule',
  ]), 'Manifest contains missing or unsupported top-level fields.');
  assert(hasExactKeys(manifest?.account, ['id', 'credentialReference']),
    'Manifest account policy contains missing or unsupported fields.');
  assert(hasExactKeys(manifest?.effectScope, [
    'publicInternet', 'channel', 'maxPublications', 'accountCreationAllowed',
  ]), 'Manifest effect scope contains missing or unsupported fields.');
  assert(hasExactKeys(manifest?.limits, [
    'maxAttempts', 'maxRequestsPerMinute', 'maxPayloadBytes',
  ]), 'Manifest limits contain missing or unsupported fields.');
  assert(hasExactKeys(manifest?.retention, [
    'evidenceDays', 'cleanupRequired', 'preserveFailedRuns',
  ]), 'Manifest retention policy contains missing or unsupported fields.');
  assert(manifest?.schemaVersion === 1, 'Manifest schemaVersion must be 1.');
  assert(typeof manifest?.id === 'string' && manifest.id.length > 0, 'Manifest id is required.');
  assert(typeof manifest?.version === 'string' && manifest.version.length > 0, 'Manifest version is required.');
  assert(['controlled-staging', 'genuine-public'].includes(manifest?.serviceClass), 'Unknown serviceClass.');
  assert(manifest?.approved === true && typeof manifest?.approvalId === 'string', 'An approval identity is required.');
  assert(isCredentialReference(manifest?.account?.credentialReference), 'Credentials must be referenced, never embedded.');
  assert(!('credential' in (manifest?.account ?? {})) && !('token' in (manifest?.account ?? {})), 'Embedded credentials are forbidden.');
  assert(hasExactValues(manifest?.allowedOperations, [
    'read_research',
    'observe_artifact',
    'publish_campaign',
    'read_publication',
    'cleanup_publication',
  ]), 'Manifest operations differ from the implemented controlled-service capabilities.');
  assert(hasExactValues(manifest?.faultSchedule, [
    'rate-limit-once',
    'commit-then-withhold-acknowledgement-once',
  ]), 'Manifest fault schedule differs from the implemented controlled-service schedule.');
  assert(Number.isSafeInteger(manifest?.effectScope?.maxPublications)
    && manifest.effectScope.maxPublications === 1, 'This harness requires exactly one permitted publication.');
  assert(Number.isSafeInteger(manifest?.limits?.maxAttempts)
    && manifest.limits.maxAttempts > 0, 'A positive attempt limit is required.');
  assert(Number.isSafeInteger(manifest?.limits?.maxPayloadBytes)
    && manifest.limits.maxPayloadBytes >= 1024, 'A payload-size limit is required.');
  assert(Number.isSafeInteger(manifest?.limits?.maxRequestsPerMinute)
    && manifest.limits.maxRequestsPerMinute > 0, 'A request-rate limit is required.');
  assert(Number.isSafeInteger(manifest?.retention?.evidenceDays)
    && manifest.retention.evidenceDays > 0, 'A positive evidence-retention period is required.');
  assert(manifest?.retention?.cleanupRequired === true
    && manifest.retention.preserveFailedRuns === true,
    'Cleanup and failed-run preservation must be explicit.');
  if (manifest?.serviceClass === 'controlled-staging') {
    assert(manifest?.effectScope?.publicInternet === false
      && manifest.effectScope.accountCreationAllowed === false,
      'Controlled evidence cannot claim public effects or account creation.');
    assert(JSON.stringify(stableValue(manifest))
      === JSON.stringify(stableValue(CONTROLLED_PUBLIC_FIXTURE_MANIFEST)),
      'Controlled manifest must match the exact reviewed policy.');
  }
  if (manifest?.serviceClass === 'genuine-public') {
    assert(allowGenuinePublic, 'Genuine-public execution requires an explicit runner opt-in.');
    assert(typeof manifest.baseUrl === 'string' && /^https:\/\//.test(manifest.baseUrl), 'Public services must use an explicit HTTPS base URL.');
    assert(operatorApproval === manifest.approvalId, 'The operator approval identity does not match the public manifest.');
    assert(manifest?.effectScope?.publicInternet === true, 'A genuine-public manifest must explicitly declare publicInternet.');
  }
  if (errors.length) {
    throw new Error('Invalid Persona goal endurance manifest:\n- ' + errors.join('\n- '));
  }
  return manifest;
}

export async function loadPublicFixtureManifest(filename) {
  if (!filename) return validatePublicFixtureManifest(structuredClone(CONTROLLED_PUBLIC_FIXTURE_MANIFEST));
  const absolute = path.resolve(filename);
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'));
  return validatePublicFixtureManifest(parsed, {
    allowGenuinePublic: process.env.PERSONA_GOAL_ENDURANCE_ALLOW_PUBLIC === 'true',
    operatorApproval: process.env.PERSONA_GOAL_ENDURANCE_PUBLIC_APPROVAL,
  });
}
