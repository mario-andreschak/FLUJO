import { assertRequiredCheckWorkflow } from './required-check-workflow.mjs';
import { FULL_JOB_IDS as REQUIRED_JOB_IDS, FULL_CHECK_NAMES as REQUIRED_CHECK_NAMES } from './verification-contract.mjs';
import { CI_NODE_PROFILES } from './verify-ci-node.mjs';
import { assertScannerWorkflowContract } from './scanner-workflow-contract.mjs';

const APPLICATION_CHANGED = "steps.application-change.outputs.changed == 'true'";
const isApplicationSelection = (file, id, condition) => file === 'verify.yml' && id === 'production-build' && condition === APPLICATION_CHANGED;

export function assertNodeRuntimeWorkflowContract(workflows) {
  const profiles = Object.values(CI_NODE_PROFILES);
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const setups = steps.flatMap((step, index) => step.uses?.startsWith('actions/setup-node@') ? [index] : []);
      if (steps.some((step) => /(?:^|\s)(?:node|npm|npx)(?:\s|$)/m.test(step.run ?? '')) && !setups.length) {
        throw new Error(`${file}/${id} executes Node commands without an exact verified runtime.`);
      }
      const versions = setups.map((index) => steps[index].with?.['node-version']);
      const expected = file === 'verify.yml' && id === 'production-build' ? [CI_NODE_PROFILES.current24, ...profiles.slice(1)]
        : setups.map(() => file === 'publish-npm.yml' ? CI_NODE_PROFILES.current24 : CI_NODE_PROFILES.current22);
      if (JSON.stringify(versions) !== JSON.stringify(expected)) throw new Error(`${file}/${id} has a missing or unpinned CI runtime profile.`);
      for (const [position, index] of setups.entries()) {
        const version = versions[position];
        const guard = steps[index + 1];
        const command = `node scripts/verify-ci-node.mjs ${version} --record`;
        const selected = isApplicationSelection(file, id, steps[index].if) && guard?.if === steps[index].if;
        if ((!selected && (steps[index].if !== undefined || guard?.if !== undefined)) || steps[index]['continue-on-error'] || guard?.run !== command || guard['continue-on-error']) {
          throw new Error(`${file}/${id} must verify official binary identity immediately after every runtime selection.`);
        }
      }
      if (setups.length && steps.slice(0, setups[0]).some((step) => /(?:^|\s)(?:node|npm|npx)(?:\s|$)/m.test(step.run ?? ''))) {
        throw new Error(`${file}/${id} executes Node commands before runtime verification.`);
      }
    }
  }
  const contractTests = ['verification-contract', 'workflow-contract', 'verify-repository-rules', 'verify-ci-node', 'node-runtime', 'scanner-workflow-contract', 'probe-filesystem-identity', 'selector-parser-security']
    .map((name) => `scripts/${name}.test.mjs`);
  const contractSteps = workflows['verify.yml']?.jobs?.['workflow-contract']?.steps ?? [];
  if (!contractSteps.some((step) => {
    const words = step.run?.trim().split(/\s+/) ?? [];
    return words[0] === 'node' && words[1] === '--test'
      && contractTests.every((file) => words.includes(file))
      && words.slice(2).every((file) => /^scripts\/[\w.-]+\.test\.mjs$/.test(file))
      && step.if === undefined && !step['continue-on-error'];
  })) {
    throw new Error('The guarded workflow-contract job must enforce all canonical runtime and verification fixtures without filters or tolerated failures.');
  }
  const build = workflows['verify.yml']?.jobs?.['production-build'];
  if (build?.env?.NODE_OPTIONS || build?.env?.NODE_V8_OPTIONS || workflows['verify.yml']?.env?.NODE_OPTIONS) {
    throw new Error('Production qualification must use the ordinary default Node heap.');
  }
  const steps = build?.steps ?? [];
  if (steps.some((step) => step.env?.NODE_OPTIONS || step.env?.NODE_V8_OPTIONS || /--max-old-space-size|NODE_OPTIONS=/i.test(step.run ?? ''))) {
    throw new Error('Production qualification commands must preserve ordinary Node options and default heap.');
  }
  if (!steps.some((step) => step.name === 'Build with the ordinary command and default Node heap' && step.run === 'npm run build')) {
    throw new Error('The ordinary default-heap build must remain mandatory.');
  }
  if (steps.flatMap(step => (step.run ?? '').split('\n')).filter(line => line === 'npm run build').length !== 1
      || steps.flatMap(step => (step.run ?? '').split('\n')).filter(line => line === 'npm ci --include=dev').length !== 1) {
    throw new Error('Production qualification must install and build once per operating system.');
  }
  const command = 'set -euo pipefail\nnpm run smoke:mcp-artifacts\n';
  for (const version of profiles.slice(1)) {
    const index = steps.findIndex((step) => step.run === `node scripts/verify-ci-node.mjs ${version} --record` && step.if === APPLICATION_CHANGED);
    const qualification = steps[index + 1];
    if (index < 0 || qualification?.shell !== 'bash' || qualification.run !== command
        || (qualification.if !== undefined && qualification.if !== APPLICATION_CHANGED) || qualification['continue-on-error'] || qualification.env?.NODE_OPTIONS) {
      throw new Error(`Node ${version} must enforce actual packed-process acceptance of the built artifacts with shell failure propagation.`);
    }
  }
  if (!steps.some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()'
      && step.with?.path === 'ci-node-runtime/' && step.with['if-no-files-found'] === 'error')) {
    throw new Error('Production runtime measurement evidence must be retained even after a failure.');
  }
}

function assertInstallerProvenance(workflow) {
  if (!Object.hasOwn(workflow?.on ?? {}, 'workflow_dispatch') || Object.hasOwn(workflow.on, 'pull_request')) throw new Error('Installer validation must remain manual/release-only.');
  const tagOnly = "${{ github.repository == 'mario-andreschak/FLUJO' && startsWith(github.ref, 'refs/tags/v') }}";
  const build = workflow?.jobs?.['installer-build'];
  const attest = workflow?.jobs?.['installer-attest'];
  const publish = workflow?.jobs?.['installer-publish'];
  if (!build || (build.permissions && Object.values(build.permissions).some((value) => value !== 'read' && value !== 'none'))
      || build.outputs?.artifact_id !== '${{ steps.installer-artifact.outputs.artifact-id }}'
      || build.outputs?.sha256 !== '${{ steps.installer-digest.outputs.sha256 }}'
      || attest?.if !== tagOnly || attest.needs !== 'installer-build'
      || publish?.if !== tagOnly || JSON.stringify(publish.needs) !== JSON.stringify(['installer-build', 'installer-attest'])
      || attest.permissions?.['id-token'] !== 'write' || attest.permissions?.attestations !== 'write'
      || attest.permissions?.['artifact-metadata'] !== 'write' || attest.permissions?.contents !== 'read'
      || publish.permissions?.contents !== 'write' || publish.permissions?.attestations !== 'read'
      || publish.permissions?.['id-token']) {
    throw new Error('Installer build/sign/publication authority or original-artifact binding changed.');
  }
  const compile = build.steps.findIndex((step) => step.name === 'Compile and validate the installer');
  const originalDigest = build.steps.findIndex((step) => step.id === 'installer-digest');
  const upload = build.steps.findIndex((step) => step.id === 'installer-artifact');
  if (compile < 0 || originalDigest <= compile || upload <= originalDigest
      || build.steps[originalDigest].run !== 'node scripts/installer-release.mjs digest'
      || build.steps[originalDigest].if || build.steps[originalDigest]['continue-on-error']) {
    throw new Error('Installer digest must be emitted from the compiled original before upload.');
  }
  for (const job of [attest, publish]) {
    const download = job.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    if (job.env?.INSTALLER_RELEASE_DIR !== 'installer/Output'
        || download?.with?.path !== '${{ env.INSTALLER_RELEASE_DIR }}') {
      throw new Error('Installer signing/publication must download into the declared workspace artifact directory.');
    }
    if (job['continue-on-error'] || download?.with?.['artifact-ids'] !== '${{ needs.installer-build.outputs.artifact_id }}'
        || job.env?.EXPECTED_INSTALLER_SHA256 !== '${{ needs.installer-build.outputs.sha256 }}'
        || job.steps.some((step) => /choco install|ISCC\.exe|npm run build/.test(step.run ?? ''))) {
      throw new Error('Installer signing/publication must reuse the original artifact without rebuilding.');
    }
  }
  const steps = attest.steps;
  const gate = steps.findIndex((step) => step.run === 'node scripts/require-release-verification.mjs installer');
  const bytes = steps.findIndex((step) => step.run === 'node scripts/installer-release.mjs validate');
  const signature = steps.findIndex((step) => step.uses?.startsWith('actions/attest@'));
  const verify = publish.steps.findIndex((step) => step.run === 'node scripts/installer-release.mjs verify-signatures');
  const recheck = publish.steps.findIndex((step) => step.run === 'node scripts/require-release-verification.mjs installer');
  const attach = publish.steps.findIndex((step) => step.uses?.startsWith('softprops/action-gh-release@'));
  const mandatory = [steps[gate], steps[bytes], steps[signature], publish.steps[verify], publish.steps[recheck], publish.steps[attach]];
  if (gate < 0 || bytes <= gate || signature <= bytes || verify < 0 || recheck <= verify || attach <= recheck
      || mandatory.some((step) => !step || step.if || step['continue-on-error'])
      || steps[signature].with?.['subject-checksums'] !== '${{ env.INSTALLER_RELEASE_DIR }}/installer-SHA256SUMS'
      || publish.steps[attach].with?.fail_on_unmatched_files !== true) {
    throw new Error('Installer signing and publication must require fresh main checks, original bytes and official signatures.');
  }
}

export function assertFullWorkflowContract(workflows) {
  assertInstallerProvenance(workflows['installer.yml']);
  assertNodeRuntimeWorkflowContract(workflows);
  assertScannerWorkflowContract(workflows['verify.yml']);
  const docsWorkflow = workflows['scorecard-source.yml'];
  const docs = docsWorkflow?.jobs?.['scorecard-source'];
  const docsSteps = docs?.steps ?? [];
  const capture = docsSteps.findIndex(step => step.run === 'node scripts/check-scorecard-ci.mjs "${{ runner.temp }}/scorecard-source-checks"');
  if (!docsWorkflow?.on || !Object.hasOwn(docsWorkflow.on, 'workflow_dispatch') || Object.hasOwn(docsWorkflow.on, 'pull_request') || Object.hasOwn(docsWorkflow.on, 'push')
      || docs?.if !== undefined || docs?.['continue-on-error'] || docs?.strategy?.['fail-fast'] !== false
      || JSON.stringify(docs?.strategy?.matrix?.os) !== JSON.stringify(['ubuntu-latest', 'windows-latest'])
      || docsWorkflow.env?.NODE_OPTIONS || docs.env?.NODE_OPTIONS
      || capture < 0 || docsSteps[capture].if !== undefined || docsSteps[capture]['continue-on-error']
      || docsSteps[capture - 1]?.run !== `node scripts/verify-ci-node.mjs ${CI_NODE_PROFILES.current22} --record`
      || !docsSteps.some(step => step.uses?.startsWith('actions/checkout@') && step.with?.['fetch-depth'] === 0)) {
    throw new Error('Dedicated Docs CI must retain both OSes, full Git history and mandatory direct capture after the verified runtime.');
  }
  for (const path of ['${{ runner.temp }}/scorecard-source-checks/', 'ci-node-runtime/']) {
    if (!docsSteps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()'
        && !step['continue-on-error'] && step.with?.path === path && step.with['if-no-files-found'] === 'error')) {
      throw new Error('Dedicated Docs CI must retain source and binary evidence even on failure.');
    }
  }
  for (const [file, workflow] of Object.entries(workflows)) {
    if (!workflow?.permissions || typeof workflow.permissions !== 'object'
        || Object.values(workflow.permissions).some((value) => value !== 'read' && value !== 'none')) {
      throw new Error(`${file} must declare a read-only workflow permission default.`);
    }
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses)) {
          throw new Error(`${file} has a mutable or unsupported action reference: ${step.uses}`);
        }
        if (step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
          throw new Error(`${file} must not persist its job token in the checkout.`);
        }
      }
    }
  }
  const journey = workflows['persona-browser-journey.yml']?.jobs?.journey;
  const journeySteps = journey?.steps ?? [];
  const checkout = journeySteps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  const trust = journeySteps.findIndex((step) => step.name === 'Verify the selected trusted checkout');
  const install = journeySteps.findIndex((step) => step.run === 'npm ci --include=dev');
  const guard = journeySteps[trust];
  const ancestry = guard?.run?.indexOf('git merge-base --is-ancestor "$PERSONA_JOURNEY_COMMIT" "$WORKFLOW_SHA"') ?? -1;
  const detach = guard?.run?.indexOf('git checkout --detach "$PERSONA_JOURNEY_COMMIT"') ?? -1;
  if (checkout < 0 || trust <= checkout || install <= trust
      || journeySteps[checkout].with?.ref !== '${{ github.sha }}'
      || guard?.env?.WORKFLOW_SHA !== '${{ github.sha }}'
      || guard.if !== undefined || guard['continue-on-error'] || ancestry < 0 || detach <= ancestry
      || !guard.run.startsWith('test "$(git rev-parse HEAD)" = "$WORKFLOW_SHA"\n')
      || !guard.run.includes('test "$(git rev-parse HEAD)" = "$PERSONA_JOURNEY_COMMIT"')
      || journeySteps.some((step) => step.with?.cache || step.uses?.startsWith('actions/cache'))) {
    throw new Error('Selected-release journeys must verify ancestry from the workflow checkout before detaching or installing, without shared caches.');
  }
  const workflow = workflows['verify.yml'];
  if (!workflow || !Object.hasOwn(workflow.on, 'workflow_dispatch') || Object.hasOwn(workflow.on, 'pull_request') || Object.hasOwn(workflow.on, 'push')) {
    throw new Error('Broad qualification must be explicitly dispatched; it cannot run on every PR or push.');
  }
  for (const id of REQUIRED_JOB_IDS) {
    const job = workflow.jobs[id];
    if (!job || job.if !== undefined || job['continue-on-error']) throw new Error(`Required job ${id} cannot be conditional or optional.`);
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      if (step.if !== undefined && !isApplicationSelection('verify.yml', id, step.if)) throw new Error(`Required command in ${id} cannot be conditional.`);
      if (step['continue-on-error'] && !['npm run test:ci', 'npm run test:isolated'].includes(step.run)) {
        throw new Error(`Unapproved optional command in ${id}.`);
      }
    }
  }
  for (const id of ['production-build', 'release-safety']) {
    if (JSON.stringify(workflow.jobs[id].strategy?.matrix?.os) !== JSON.stringify(['ubuntu-latest', 'windows-latest'])) {
      throw new Error(`${id} must cover Ubuntu and Windows.`);
    }
  }
  const names = [...REQUIRED_JOB_IDS, 'verification'].flatMap((id) => {
    const job = workflow.jobs[id];
    return job.strategy?.matrix?.os
      ? job.strategy.matrix.os.map((os) => job.name.replace('${{ matrix.os }}', os))
      : job.strategy?.matrix?.language
        ? job.strategy.matrix.language.map((language) => job.name.replace('${{ matrix.language }}', language))
        : [job.name];
  });
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED_CHECK_NAMES)) throw new Error('Required check names drifted from the publication contract.');
  const build = workflow.jobs['production-build'].steps;
  if (build.some(step => step.if === APPLICATION_CHANGED)) {
    const selection = build.find(step => step.id === 'application-change');
    const syntax = build.find(step => step.name === 'Validate Worker publisher shell syntax');
    if (!build.some(step => step.uses?.startsWith('actions/checkout@') && step.with?.['fetch-depth'] === 0)
        || !selection || selection.if !== undefined || selection['continue-on-error'] || selection.shell !== 'bash'
        || selection.env?.BASE_REVISION !== '${{ github.event.pull_request.base.sha }}'
        || selection.env?.HEAD_REVISION !== '${{ github.event.pull_request.head.sha }}'
        || !selection.run?.includes("['diff', '--name-only', '-z', base, head]")
        || !syntax || syntax.if !== undefined || syntax['continue-on-error'] || !syntax.run?.includes('bash -n')) {
      throw new Error('Workflow-only qualification requires the exact Git revision comparison and mandatory publisher shell syntax validation.');
    }
  }
  for (const command of ['npm run build', 'npm run typecheck:mcp', 'npm run validate:mcp-release', 'npm run smoke:mcp-artifacts']) {
    if (!build.some((step) => step.run?.split('\n').includes(command))) throw new Error(`Production checks omitted ${command}.`);
  }
  for (const [id, stage, report] of [['test', 'ci', 'jest-results.json'], ['test-isolated', 'isolated', 'jest-results-isolated.json']]) {
    const steps = workflow.jobs[id].steps;
    const execute = steps.findIndex((step) => step.run === `npm run test:${stage}`);
    const baseline = steps.findIndex((step) => step.run === `npm run verify:test-baseline -- --stage=${stage} --results=${report}`);
    if (execute < 0 || baseline <= execute || steps[baseline]['continue-on-error']) {
      throw new Error(`${id} must enforce completed assertions and explicit skip accounting after Jest.`);
    }
  }
  const mainTests = workflow.jobs.test.steps;
  const isolation = mainTests.findIndex(step => step.name === 'Prepare real Linux MCP isolation image');
  const suite = mainTests.findIndex(step => step.run === 'npm run test:ci');
  if (isolation < 0 || isolation >= suite || mainTests[isolation].if !== undefined
      || mainTests[isolation]['continue-on-error'] || mainTests[isolation].shell !== 'bash'
      || !mainTests[isolation].run?.includes('set -euo pipefail')
      || !mainTests[isolation].run?.includes('FLUJO_TEST_ISOLATION_IMAGE=$image')
      || !mainTests[isolation].run?.includes('unix:///var/run/docker.sock')
      || mainTests[suite].env?.FLUJO_RUN_ISOLATION_SOURCE_PROBE !== '1') {
    throw new Error('Main CI must prepare a real Linux Docker image and execute both MCP isolation probes.');
  }
  const gate = workflow.jobs.verification;
  if (gate?.name !== 'verification' || gate.if !== 'always()'
      || JSON.stringify(gate.needs) !== JSON.stringify(REQUIRED_JOB_IDS)
      || gate['continue-on-error'] || !gate.steps.some((step) => step.run?.includes('assertFullDependencyResults') && step.if === undefined && !step['continue-on-error'])) {
    throw new Error('The required verification check must evaluate every prerequisite even after failures.');
  }
}

export function assertWorkflowContract(workflows) {
  assertRequiredCheckWorkflow(workflows['verify.yml']);
  for (const [name, workflow] of Object.entries(workflows)) {
    if (name !== 'verify.yml' && (Object.hasOwn(workflow.on ?? {}, 'pull_request') || Object.hasOwn(workflow.on ?? {}, 'pull_request_target'))) throw new Error('Only focused verification may run on pull requests: ' + name);
  }
  const { 'verify.yml': focused, 'verify-full.yml': full, ...other } = workflows;
  if (!full) throw new Error('Manual broad qualification is missing.');
  assertFullWorkflowContract({ ...other, 'verify.yml': full });
}
