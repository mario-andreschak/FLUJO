import { REQUIRED_JOB_IDS, REQUIRED_CHECK_NAMES } from './verification-contract.mjs';

function assertInstallerProvenance(workflow) {
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

export function assertWorkflowContract(workflows) {
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
  assertInstallerProvenance(workflows['installer.yml']);
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
      || guard.if || guard['continue-on-error'] || ancestry < 0 || detach <= ancestry
      || !guard.run.startsWith('test "$(git rev-parse HEAD)" = "$WORKFLOW_SHA"\n')
      || !guard.run.includes('test "$(git rev-parse HEAD)" = "$PERSONA_JOURNEY_COMMIT"')
      || journeySteps.some((step) => step.with?.cache || step.uses?.startsWith('actions/cache'))) {
    throw new Error('Selected-release journeys must verify ancestry from the workflow checkout before detaching or installing, without shared caches.');
  }
  const workflow = workflows['verify.yml'];
  if (!workflow || !Object.hasOwn(workflow.on, 'pull_request')
      || workflow.on.pull_request != null
      || !workflow.on.push?.branches?.includes('main') || workflow.on.push.paths || workflow.on.push['paths-ignore']) {
    throw new Error('Verification must run for every pull request and main push without path filters.');
  }
  for (const id of REQUIRED_JOB_IDS) {
    const job = workflow.jobs[id];
    if (!job || job.if || job['continue-on-error']) throw new Error(`Required job ${id} cannot be conditional or optional.`);
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      if (step.if) throw new Error(`Required command in ${id} cannot be conditional.`);
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
  const gate = workflow.jobs.verification;
  if (gate?.name !== 'verification' || gate.if !== 'always()'
      || JSON.stringify(gate.needs) !== JSON.stringify(REQUIRED_JOB_IDS)
      || gate['continue-on-error'] || !gate.steps.some((step) => step.run?.includes('assertDependencyResults') && !step.if && !step['continue-on-error'])) {
    throw new Error('The required verification check must evaluate every prerequisite even after failures.');
  }
}
