import { assertRequiredCheckWorkflow } from './required-check-workflow.mjs';
import { FULL_JOB_IDS as REQUIRED_JOB_IDS, FULL_CHECK_NAMES as REQUIRED_CHECK_NAMES, REQUIRED_CHECK_NAMES as MAIN_CHECK_NAMES } from './verification-contract.mjs';
import { CI_NODE_PROFILES } from './verify-ci-node.mjs';
import { assertScannerWorkflowContract } from './scanner-workflow-contract.mjs';

const APPLICATION_CHANGED = "steps.application-change.outputs.changed == 'true'";
const isApplicationSelection = (file, id, condition) => file === 'verify.yml' && id === 'production-build' && condition === APPLICATION_CHANGED;

const VERIFICATION_MATRIX_RUNNER = "${{ matrix.os == 'ubuntu-latest' && 'ubuntu-24.04' || matrix.os }}";

/** Jobs only the manual broad qualification runs; its verification gate needs them too. */
const BROAD_ONLY_JOB_IDS = Object.freeze(['antigravity-cli', 'installed-windows-acceptance', 'image-acceptance', 'system-key-store', 'system-key-store-linux', 'contributor-guide', 'first-use-journey', 'scripted-pilot', 'claude-code', 'chat-burst-load']);
const JOURNEY_DESKTOP = 'npm run journey:first-use';
const JOURNEY_PHONE = 'npm run journey:first-use -- --viewport 390x844';
const BIG_APP = 'npx playwright test --config=playwright.features-first-use.config.mjs';
const TOOL_TESTER = 'npx playwright test --config=playwright.features.config.mjs';
const FRONT_DOOR = 'npm run journey:front-door';

/**
 * The first-use journey (#572) walks a fresh production build on desktop and
 * phone screens, then reaches every tool of a 128-tool app and tests the tool
 * tester on that build, with nothing optional, and keeps its evidence even when it fails.
 * On the same build, an app view must show in a chat opened through a signed-in
 * front door (#1336).
 */
export function assertFirstUseJourneyJob(workflow) {
  const job = workflow?.jobs?.['first-use-journey'];
  const steps = job?.steps ?? [];
  const at = (run) => steps.findIndex(step => step.run === run);
  const [install, browser, build, desktop, phone, bigApp, toolTester, frontDoor] = ['npm ci --include=dev', 'npx playwright install --with-deps chromium',
    'npm run build', JOURNEY_DESKTOP, JOURNEY_PHONE, BIG_APP, TOOL_TESTER, FRONT_DOOR].map(at);
  const evidence = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const kept = (evidence?.with?.path ?? '').split('\n').map(line => line.trim());
  if (!job || job['runs-on'] !== 'ubuntu-24.04' || job.if !== undefined || job['continue-on-error'] || job.strategy
      || install < 0 || browser <= install || build <= browser || desktop <= build || phone <= build || bigApp <= build
      || toolTester <= build
      || [bigApp, toolTester].some(index => steps[index].env?.FEATURE_BROWSER_APP_DIR !== '${{ github.workspace }}')
      || steps.some(step => step.run && (step.if !== undefined || step['continue-on-error']))
      || evidence?.if !== 'always()' || !kept.some(line => line.endsWith('/flujo-drive/evidence/first-journey/'))
      || !kept.includes('feature-first-use-artifacts/') || !kept.includes('feature-browser-artifacts/')) {
    throw new Error('The broad qualification must walk the first-use journey on desktop and phone after a fresh production build '
      + 'and reach every tool of the 128-tool app and test the tool tester on that build, with nothing optional, '
      + 'and keep its screenshots and reports even when it fails.');
  }
  if (frontDoor <= build || !kept.some(line => line.endsWith('/flujo-drive/evidence/front-door/'))) {
    throw new Error('The broad qualification must show an app view in a chat through a signed-in front door '
      + `(${FRONT_DOOR}) after the production build, with nothing optional, and keep its screenshots and report even when it fails.`);
  }
}
const ANTIGRAVITY_INSTALL = "node -e \"require('./bin/antigravity-runtime.cjs').resolveBinary().then(binary => console.log(binary))\"";
const ANTIGRAVITY_SUITE = 'node scripts/run-local-jest.cjs --ci --selectProjects node --runInBand --runTestsByPath __tests__/model/antigravityCliIntegration.test.ts';

/**
 * The official Antigravity CLI runs against the local stand-in model on macOS
 * and Windows (the main test job covers Linux), installed by FLUJO's own
 * installer, with nothing optional.
 */
export function assertAntigravityPlatformJob(workflow) {
  const job = workflow?.jobs?.['antigravity-cli'];
  const matrix = job?.strategy?.matrix;
  const steps = job?.steps ?? [];
  const install = steps.findIndex(step => step.run === 'npm ci --include=dev');
  const cli = steps.findIndex(step => step.run === ANTIGRAVITY_INSTALL);
  const suite = steps.findIndex(step => step.run === ANTIGRAVITY_SUITE);
  if (!job || job.name !== 'Antigravity CLI (${{ matrix.os }})' || job['runs-on'] !== '${{ matrix.os }}'
      || job.if !== undefined || job['continue-on-error'] || job.strategy['fail-fast'] !== false
      || Object.keys(matrix ?? {}).join() !== 'os' || JSON.stringify(matrix.os) !== JSON.stringify(['macos-latest', 'windows-latest'])
      || install < 0 || cli <= install || suite <= cli
      || steps.some(step => step.if !== undefined || step['continue-on-error'])) {
    throw new Error('The broad qualification must run the official Antigravity CLI suite on macOS and Windows after installing the CLI the way FLUJO does, with nothing optional.');
  }
}

const CLAUDE_CODE_SUITES = 'node scripts/run-local-jest.cjs --ci --selectProjects node --runInBand --runTestsByPath __tests__/model/claudeCodeStandIn.test.ts __tests__/chat/claudeFlowStandIn.test.ts';

/**
 * The Claude Code bundled for macOS and Windows runs FLUJO's Claude suites
 * against the local stand-in of Anthropic's service (Linux runs them in
 * test-isolated), with every case and nothing optional (#1092, #1096, #756).
 */
export function assertClaudeCodePlatformJob(workflow) {
  const job = workflow?.jobs?.['claude-code'];
  const matrix = job?.strategy?.matrix;
  const steps = job?.steps ?? [];
  const install = steps.findIndex(step => step.run === 'npm ci --include=dev');
  const suite = steps.findIndex(step => step.run === CLAUDE_CODE_SUITES);
  if (!job || job.name !== 'Claude Code (${{ matrix.os }})' || job['runs-on'] !== '${{ matrix.os }}'
      || job.if !== undefined || job['continue-on-error'] || job.strategy['fail-fast'] !== false
      || Object.keys(matrix ?? {}).join() !== 'os' || JSON.stringify(matrix.os) !== JSON.stringify(['macos-latest', 'windows-latest'])
      || install < 0 || suite <= install
      || steps.some(step => step.if !== undefined || step['continue-on-error'])) {
    throw new Error('The broad qualification must run the bundled Claude Code suites against the Anthropic stand-in on macOS and Windows after installing dependencies, with nothing optional.');
  }
}

const GUIDE_WALKTHROUGH = 'node scripts/contributor-guide.mjs --report "${{ runner.temp }}/contributor-guide"';
const GUIDE_REPORT = '${{ runner.temp }}/contributor-guide/';

/**
 * A machine follows the contributor guide on Linux and macOS (#1441): a full-history checkout, the
 * verified Node runtime, the walkthrough with no extra settings and nothing optional, and its
 * report and logs kept even when a step fails.
 */
export function assertContributorGuideJob(workflow) {
  const job = workflow?.jobs?.['contributor-guide'];
  const matrix = job?.strategy?.matrix;
  const steps = job?.steps ?? [];
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  const guard = steps.findIndex(step => step.run === `node scripts/verify-ci-node.mjs ${CI_NODE_PROFILES.current22} --record`);
  const walk = steps.findIndex(step => step.run === GUIDE_WALKTHROUGH);
  const keep = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  if (!job || job.name !== 'Contributor guide (${{ matrix.os }})' || job['runs-on'] !== '${{ matrix.os }}'
      || job.if !== undefined || job['continue-on-error'] || job.env !== undefined || job.strategy?.['fail-fast'] !== false
      || Object.keys(matrix ?? {}).join() !== 'os' || JSON.stringify(matrix.os) !== JSON.stringify(['ubuntu-latest', 'macos-latest'])
      || checkout?.with?.['fetch-depth'] !== 0 || guard < 0 || walk <= guard || keep <= walk || steps[walk].env !== undefined
      || steps[keep].if !== 'always()' || steps[keep].with?.path !== GUIDE_REPORT || steps[keep].with['if-no-files-found'] !== 'error'
      || steps.some(step => step['continue-on-error'] || (step.if !== undefined && step !== steps[keep]))) {
    throw new Error('The broad qualification must follow the contributor guide on Linux and macOS: a full-history checkout, '
      + `the verified Node runtime, \`${GUIDE_WALKTHROUGH}\` with no extra settings and nothing optional, `
      + 'and its report kept even when a step fails.');
  }
}

/** Jobs that must run on one exact non-Linux image, with the reason. */
const NON_LINUX_VERIFICATION_JOBS = Object.freeze({
  'installed-windows-acceptance': ['windows-latest', 'Installs this revision with the real flujo-setup.exe, which only runs on Windows (#570).'],
});

const SYSTEM_KEY_CHECK = 'node scripts/check-system-key-store.mjs';
const LINUX_KEYRING_INSTALL = 'sudo apt-get update\nsudo apt-get install -y --no-install-recommends gnome-keyring libsecret-tools dbus\n';

/**
 * FLUJO's system key (#1443) is proven against the real key store of every
 * system by CI, never by a person: Windows data protection and the macOS
 * Keychain, and on Linux a throwaway keyring with the locked, no-service and
 * no-session fallbacks. The check script picks the situations itself; the
 * jobs only install what it needs and run it, with nothing optional.
 */
export function assertSystemKeyStoreJobs(workflow) {
  const fail = () => {
    throw new Error('The broad qualification must prove the system key against the real key store on macOS, Windows and Linux: '
      + `run "${SYSTEM_KEY_CHECK}" after npm ci (on Linux after installing the keyring), with no conditions, `
      + 'no tolerated failures and no environment that changes what it checks.');
  };
  const runsInOrder = (steps, ...matchers) => {
    let previous = -1;
    for (const matches of matchers) {
      const index = steps.findIndex(matches);
      if (index <= previous) return false;
      previous = index;
    }
    return true;
  };
  const desktop = workflow?.jobs?.['system-key-store'];
  const linux = workflow?.jobs?.['system-key-store-linux'];
  for (const job of [desktop, linux]) {
    const steps = job?.steps ?? [];
    const checks = steps.filter(step => step.run === SYSTEM_KEY_CHECK);
    if (!job || job.if !== undefined || job['continue-on-error'] || job.env !== undefined
        || steps.some(step => step.if !== undefined || step['continue-on-error'])
        || checks.length !== 1 || checks[0].env !== undefined
        || !runsInOrder(steps, step => step.run === 'npm ci --include=dev', step => step.run === SYSTEM_KEY_CHECK)) fail();
  }
  const matrix = desktop.strategy?.matrix;
  if (desktop.name !== 'System key store (${{ matrix.os }})' || desktop['runs-on'] !== '${{ matrix.os }}'
      || desktop.strategy['fail-fast'] !== false || Object.keys(matrix ?? {}).join() !== 'os'
      || JSON.stringify(matrix.os) !== JSON.stringify(['macos-latest', 'windows-latest'])) fail();
  if (linux.name !== 'System key store (Linux keyring)' || linux['runs-on'] !== 'ubuntu-24.04' || linux.strategy !== undefined
      || !runsInOrder(linux.steps, step => step.run === LINUX_KEYRING_INSTALL, step => step.run === SYSTEM_KEY_CHECK)) fail();
}

const PILOT_RUN = 'npm run pilot:scripted -- --mode start --out "$RUNNER_TEMP/scripted-pilot"';
const PILOT_EVIDENCE = '${{ runner.temp }}/scripted-pilot/';

/**
 * The pilot that replaced people (#577): scripted first-time users on a fresh production build, on
 * Linux and Windows, with nothing optional, and its result and evidence kept even when it fails.
 */
export function assertScriptedPilotJob(workflow) {
  const job = workflow?.jobs?.['scripted-pilot'];
  const steps = job?.steps ?? [];
  const order = ['npm ci --include=dev', 'npx playwright install --with-deps chromium', 'npm run build', PILOT_RUN]
    .map(command => steps.findIndex(step => step.run === command));
  const pilot = order.at(-1);
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  const kept = steps[upload];
  const afterPilot = steps.slice(pilot + 1);
  if (!job || job.name !== 'Scripted pilot (${{ matrix.os }})' || job['runs-on'] !== '${{ matrix.os }}'
      || job.if !== undefined || job['continue-on-error'] || job.strategy?.['fail-fast'] !== false
      || Object.keys(job.strategy?.matrix ?? {}).join() !== 'os'
      || JSON.stringify(job.strategy.matrix.os) !== JSON.stringify(['ubuntu-24.04', 'windows-latest'])
      || order.some((index, position) => index < 0 || (position > 0 && index <= order[position - 1]))
      || steps.some(step => step['continue-on-error'])
      || steps.slice(0, pilot + 1).some(step => step.if !== undefined)
      || afterPilot.some(step => step.if !== 'always()')
      || upload <= pilot || kept.with?.path !== PILOT_EVIDENCE || kept.with['if-no-files-found'] !== 'error') {
    throw new Error('The broad qualification must run the scripted pilot (npm run pilot:scripted) on a production build on Linux and Windows, with nothing optional, and keep its result even when it fails.');
  }
}

const CHAT_BURST = 'node scripts/chat-burst-load-test.mjs';
/** The load test runs, in this order, exactly as written: its pass rules live in the script, not here. */
export const CHAT_BURST_RUNS = Object.freeze([
  `${CHAT_BURST} --parallel 300 --mode stream --out "$RUNNER_TEMP/chat-burst/stream-300.json"`,
  `${CHAT_BURST} --parallel 300 --mode json --out "$RUNNER_TEMP/chat-burst/json-300.json"`,
  `${CHAT_BURST} --parallel 50 --mode json --out "$RUNNER_TEMP/chat-burst/json-50.json"`,
  `${CHAT_BURST} --parallel 300 --mode stream --cold-start --out "$RUNNER_TEMP/chat-burst/cold-start-300.json"`,
]);
const CHAT_BURST_RESULTS = '${{ runner.temp }}/chat-burst/';

/**
 * Issue #757 is rerun without anyone (docs/performance/chat-burst-load-test.md): 300 parallel
 * chats, streamed and plain, 50 plain, and 300 while FLUJO is starting, on a fresh production
 * build with a local stand-in model and nothing optional. Each run fails on a lost or refused
 * request or a slow first model call; the results are kept even when a run fails.
 */
export function assertChatBurstLoadJob(workflow) {
  const job = workflow?.jobs?.['chat-burst-load'];
  const steps = job?.steps ?? [];
  const order = ['npm ci --include=dev', 'npm run build', ...CHAT_BURST_RUNS].map(command => steps.findIndex(step => step.run === command));
  const keep = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  const runs = steps.filter(step => step.run?.includes(CHAT_BURST));
  if (!job || job.name !== 'Chat burst load test' || job['runs-on'] !== 'ubuntu-24.04' || job.if !== undefined
      || job['continue-on-error'] || job.strategy !== undefined || job.env !== undefined
      || order.some((index, position) => index < 0 || (position > 0 && index <= order[position - 1]))
      || runs.length !== CHAT_BURST_RUNS.length || runs.some(step => step.shell !== 'bash' || step.env !== undefined)
      || steps.some(step => step['continue-on-error'] || (step.if !== undefined && step !== steps[keep]))
      || keep <= order.at(-1) || steps[keep].if !== 'always()' || steps[keep].with?.path !== CHAT_BURST_RESULTS
      || steps[keep].with['if-no-files-found'] !== 'error') {
    throw new Error('The broad qualification must rerun the #757 chat burst load test on a fresh production build: '
      + `after "npm ci --include=dev" and "npm run build", run ${CHAT_BURST_RUNS.map(run => `"${run}"`).join(', then ')} `
      + `in bash with no extra settings and nothing optional, and keep ${CHAT_BURST_RESULTS} even when a run fails.`);
  }
}

function assertVerificationRunners(workflow) {
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    // Their runners are checked by assertAntigravityPlatformJob, assertSystemKeyStoreJobs,
    // assertContributorGuideJob, assertScriptedPilotJob and assertClaudeCodePlatformJob.
    if (['antigravity-cli', 'system-key-store', 'system-key-store-linux', 'contributor-guide', 'scripted-pilot', 'claude-code'].includes(id)) continue;
    if (Object.hasOwn(NON_LINUX_VERIFICATION_JOBS, id)) {
      if (job['runs-on'] !== NON_LINUX_VERIFICATION_JOBS[id][0]) throw new Error(`${id} must run on ${NON_LINUX_VERIFICATION_JOBS[id][0]}: ${NON_LINUX_VERIFICATION_JOBS[id][1]}`);
    } else if (['production-build', 'release-safety'].includes(id)) {
      const matrix = job.strategy?.matrix;
      if (job['runs-on'] !== VERIFICATION_MATRIX_RUNNER
          || !matrix || Object.keys(matrix).length !== 1 || !Array.isArray(matrix.os)) {
        throw new Error(`${id} must pin Linux to Ubuntu 24.04, preserve Windows selection and retain its exact OS matrix.`);
      }
    } else if (job['runs-on'] !== 'ubuntu-24.04') {
      throw new Error(`${id} must run verification on the qualified Ubuntu 24.04 image.`);
    }
  }
}

export function assertNodeRuntimeWorkflowContract(workflows) {
  const profiles = [...new Set(Object.values(CI_NODE_PROFILES))];
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
  const contractTests = ['verification-contract', 'workflow-contract', 'verify-repository-rules', 'verify-ci-node', 'node-runtime', 'scanner-workflow-contract', 'probe-filesystem-identity', 'selector-parser-security', 'qualify-conversation-recovery']
    .map((name) => `scripts/${name}.test.mjs`);
  const contractSteps = workflows['verify.yml']?.jobs?.['workflow-contract']?.steps ?? [];
  const contractCheckout = contractSteps.find(step => step.uses?.startsWith('actions/checkout@'));
  if (contractCheckout?.with?.['fetch-depth'] !== 0) {
    throw new Error('Workflow integrity checks require full history for the pinned historical fixtures.');
  }
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
  for (const id of ['powershell-tests', 'clean-windows']) {
    const checkout = workflow.jobs?.[id]?.steps?.find(step => step.uses?.startsWith('actions/checkout@'));
    if (checkout?.with?.['fetch-depth'] !== 0) {
      throw new Error('Installer decision checks require full history for the pinned signed checksum fixture.');
    }
  }
  const tagOnly = "${{ github.repository == 'mario-andreschak/FLUJO' && startsWith(github.ref, 'refs/tags/v') }}";
  const build = workflow?.jobs?.['installer-build'];
  const attest = workflow?.jobs?.['installer-attest'];
  const acceptance = workflow?.jobs?.['installer-acceptance'];
  const publish = workflow?.jobs?.['installer-publish'];
  if (!build || (build.permissions && Object.values(build.permissions).some((value) => value !== 'read' && value !== 'none'))
      || build.outputs?.artifact_id !== '${{ steps.installer-artifact.outputs.artifact-id }}'
      || build.outputs?.sha256 !== '${{ steps.installer-digest.outputs.sha256 }}'
      || attest?.if !== tagOnly || JSON.stringify(attest.needs) !== JSON.stringify(['installer-build', 'artifact-smoke', 'installer-acceptance'])
      || publish?.if !== tagOnly || JSON.stringify(publish.needs) !== JSON.stringify(['installer-build', 'installer-attest'])
      || attest.permissions?.['id-token'] !== 'write' || attest.permissions?.attestations !== 'write'
      || attest.permissions?.['artifact-metadata'] !== 'write' || attest.permissions?.contents !== 'read'
      || publish.permissions?.contents !== 'write' || publish.permissions?.attestations !== 'read'
      || publish.permissions?.['id-token']) {
    throw new Error('Installer build/sign/publication authority or original-artifact binding changed.');
  }
  const acceptanceDownload = acceptance?.steps?.find(step => step.uses?.startsWith('actions/download-artifact@'));
  const installedCheck = acceptance?.steps?.find(step => step.run === "./scripts/verify-windows-install.ps1 -BootstrapNode:('${{ matrix.os }}' -eq 'windows-2025') -ExistingOutdatedNode:('${{ matrix.os }}' -eq 'windows-2022')");
  if (acceptance?.needs !== 'installer-build' || acceptance.if || acceptance['continue-on-error']
      || acceptance['runs-on'] !== '${{ matrix.os }}'
      || JSON.stringify(acceptance.strategy?.matrix?.os) !== JSON.stringify(['windows-2022', 'windows-2025'])
      || acceptanceDownload?.with?.['artifact-ids'] !== '${{ needs.installer-build.outputs.artifact_id }}'
      || acceptanceDownload.with.path !== 'installer/Output'
      || acceptance.env?.EXPECTED_INSTALLER_SHA256 !== '${{ needs.installer-build.outputs.sha256 }}'
      || !installedCheck || installedCheck.if || installedCheck['continue-on-error']
      || acceptance.steps.some(step => /ISCC\.exe|npm run build/.test(step.run ?? ''))) {
    throw new Error('Installer acceptance must install and launch the original compiled bytes before signing.');
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

// Write access that can publish, sign or tag something people download.
const PUBLISHING_PERMISSIONS = ['contents', 'packages', 'id-token', 'attestations', 'artifact-metadata', 'pages'];
const RELEASE_GATE = /^node scripts\/require-release-verification\.mjs (?:npm|image|installer)$/;
const SIGNING_OR_PUBLISHING_ACTION = /^(?:actions\/attest|softprops\/action-gh-release|actions\/deploy-pages)@/;
const SIGNING_OR_PUBLISHING_COMMAND = /scripts\/(?:npm-release\.mjs (?:publish|finalize)|image-release\.mjs (?:candidate|promote))\b|\b(?:docker push|npm publish|gh release (?:create|upload|edit))\b/;

/**
 * Jobs that hold publishing permissions but do not publish a release. This list
 * may only shrink; every new entry needs a reason a reviewer can check.
 */
export const RELEASE_GATE_EXCEPTIONS = Object.freeze({
  'pages.yml/deploy': 'Publishes the project website from main; it is not a downloadable release.',
  'publish-cloud-worker.yml/publish': 'Advances the separate cloud-worker channel after smoke-testing the exact image it pushes; it is not a release.',
  'publish-npm.yml/diagnose-oidc': 'Only checks the npm trusted-publisher token exchange; it never publishes.',
  'release-evidence.yml/attach': 'Adds read-only evidence and reassessment pages to a release that already exists; it publishes no installable file.',
});

/**
 * Every job that can publish or sign must first require the successful
 * exact-commit main verification run, unconditionally, before its first
 * publishing or signing step. A new release workflow that forgets this fails.
 */
export function assertReleaseVerificationGates(workflows) {
  for (const key of Object.keys(RELEASE_GATE_EXCEPTIONS)) {
    const [file, id] = key.split('/');
    if (!workflows[file]?.jobs?.[id]) throw new Error(`Release gate exception ${key} no longer matches a job; remove it.`);
  }
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
      const permissions = job.permissions ?? workflow.permissions ?? {};
      const canPublish = typeof permissions === 'string'
        ? permissions === 'write-all'
        : PUBLISHING_PERMISSIONS.some((name) => permissions[name] === 'write');
      if (!canPublish || Object.hasOwn(RELEASE_GATE_EXCEPTIONS, `${file}/${id}`)) continue;
      const steps = job.steps ?? [];
      const gate = steps.findIndex((step) => RELEASE_GATE.test(step.run?.trim().split('\n')[0] ?? ''));
      const firstPublication = steps.findIndex((step) => SIGNING_OR_PUBLISHING_ACTION.test(step.uses ?? '')
        || SIGNING_OR_PUBLISHING_COMMAND.test(step.run ?? ''));
      if (gate < 0 || steps[gate].if !== undefined || steps[gate]['continue-on-error']
          || (firstPublication >= 0 && firstPublication < gate)) {
        throw new Error(`${file}/${id} can publish or sign without first requiring successful exact-commit main verification.`);
      }
    }
  }
}

const PACKAGED_ACCEPTANCE = 'node scripts/packaged-acceptance.mjs ';
const OPERATOR_RUNBOOK = 'node scripts/operator-runbook.mjs ';
export const PACKAGED_ACCEPTANCE_TESTS = 'node --test scripts/packaged-acceptance.test.mjs scripts/packaged-acceptance/low-disk.test.mjs scripts/packaged-acceptance/stand-ins.test.mjs scripts/operator-runbook.test.mjs';
const uploads = step => step.uses?.startsWith('actions/upload-artifact@');

/**
 * `command` runs exactly once in `file`/`id`, mandatory, after the step
 * `isBefore` finds and before the step `isAfter` finds; returns its index.
 */
function assertOrderedCommand(workflows, file, id, command, form, isBefore, isAfter, message) {
  const job = workflows[file]?.jobs?.[id];
  const steps = job?.steps ?? [];
  const indexes = steps.flatMap((step, index) => step.run?.includes(command) ? [index] : []);
  const step = steps[indexes[0]];
  const allowedCondition = file === 'verify.yml' && id === 'production-build' ? [undefined, APPLICATION_CHANGED] : [undefined];
  const before = steps.findIndex(isBefore);
  const after = steps.findIndex((item, index) => index > indexes[0] && isAfter(item));
  // Release jobs may be switched by their own dispatch inputs; a skipped one publishes nothing.
  const conditionalJob = file === 'verify.yml' && job?.if !== undefined;
  if (!job || conditionalJob || job['continue-on-error'] || indexes.length !== 1 || !step.run.includes(form)
      || step['continue-on-error'] || !allowedCondition.includes(step.if) || before < 0 || before > indexes[0] || after < 0) {
    throw new Error(message);
  }
  return indexes[0];
}

/**
 * Every shipped form runs the same backup, restart, upgrade, disk-full,
 * schedule and restore checks before it is published, and the operator
 * runbook is followed word for word (#570). The broad run covers the npm
 * package on both systems, the installed Windows build and the Docker image.
 */
export function assertPackagedAcceptance(workflows, { mainIntegration = false } = {}) {
  const forms = [
    ['publish-npm.yml', 'prepare', '--form npm --tarballs ', step => step.run === 'node scripts/npm-release.mjs prepare', uploads],
    ['publish-image.yml', 'candidate', '--form docker ', step => step.id === 'smoke', step => step.run === 'node scripts/image-release.mjs candidate'],
    ['installer.yml', 'installer-acceptance', '--form checkout ', step => step.run?.startsWith('./scripts/verify-windows-install.ps1'), uploads],
    ...(mainIntegration ? [] : [
      ['verify.yml', 'production-build', '--form npm --pack ', step => step.run?.includes('npm run smoke:mcp-artifacts'), step => step.name === 'Retain exact runtime measurements'],
      ['verify.yml', 'installed-windows-acceptance', '--form checkout ', step => step.run?.startsWith('./scripts/verify-windows-install.ps1'), step => uploads(step) && step.if === 'always()'],
      ['verify.yml', 'image-acceptance', '--form docker ', step => step.uses?.startsWith('docker/build-push-action@') && step.with?.load === true && step.with?.push === false,
        step => uploads(step) && step.if === 'always()'],
    ]),
  ];
  for (const [file, id, form, isBefore, isAfter] of forms) {
    const index = assertOrderedCommand(workflows, file, id, PACKAGED_ACCEPTANCE, form, isBefore, isAfter,
      `${file}/${id} must run the backup, restart, upgrade, disk-full, schedule and restore checks on its shipped form after it is built and before it is kept or published.`);
    if (!/ --from (?:npm|image):\S+/.test(workflows[file].jobs[id].steps[index].run)) {
      throw new Error(`${file}/${id} must check its shipped form as an upgrade from the latest published release (--from).`);
    }
  }
  const installer = workflows['verify.yml']?.jobs?.['installed-windows-acceptance']?.steps ?? [];
  const compiled = installer.findIndex(step => step.run?.includes('installer\\flujo-setup.iss'));
  if (!mainIntegration && (compiled < 0 || compiled > installer.findIndex(step => step.run?.startsWith('./scripts/verify-windows-install.ps1')))) {
    throw new Error('The installed Windows build check must compile flujo-setup.exe from this revision before installing it.');
  }
  const runbooks = [
    ['publish-npm.yml', 'prepare', '--tarballs ', step => step.run?.includes(`${PACKAGED_ACCEPTANCE}--form npm`), uploads],
    ...(mainIntegration ? [] : [['verify.yml', 'production-build', '--pack', step => step.run?.includes(`${PACKAGED_ACCEPTANCE}--form npm`),
      step => step.name === 'Retain the packaged acceptance report']]),
  ];
  for (const [file, id, form, isBefore, isAfter] of runbooks) {
    assertOrderedCommand(workflows, file, id, OPERATOR_RUNBOOK, form, isBefore, isAfter,
      `${file}/${id} must follow the operator runbook with the packages it checked, before they are kept or published.`);
  }
  const safety = workflows['verify.yml']?.jobs?.['release-safety']?.steps ?? [];
  const unit = safety.find(step => step.run === PACKAGED_ACCEPTANCE_TESTS);
  if (!unit || unit.if !== undefined || unit['continue-on-error']) {
    throw new Error(`Release safety must run the packaged acceptance and operator runbook tests on both operating systems: ${PACKAGED_ACCEPTANCE_TESTS}`);
  }
}

export const CONTAINER_SMOKE_TAG = 'flujo-container-smoke:${{ github.sha }}';
export const CONTAINER_SMOKE_COMMAND = 'set -euo pipefail\nnode scripts/smoke-container-image.mjs --image "flujo-container-smoke:${GITHUB_SHA}" --report "$RUNNER_TEMP/container-smoke/report.json"\n';
export const RELEASE_CONTAINER_SMOKE_COMMAND = 'set -euo pipefail\nnode scripts/smoke-container-image.mjs --image "$TESTED_IMAGE_ID"\n';

/**
 * The container image is built from every main-target change and from the release candidate,
 * and that exact image must pass the container smoke (#1408): its declared Node, its health
 * check and published port, a first chat and the voice check against local stand-ins, and a
 * hard stop that loses no finished turn.
 */
export function assertContainerSmoke(workflows) {
  const fail = (where, what) => {
    throw new Error(`${where} must ${what}. Run "${CONTAINER_SMOKE_COMMAND.split('\n')[1]}" right after building the image, `
      + 'with nothing optional; see docs/operations/ci-node-runtime-verification.md, section "Container smoke".');
  };
  const optional = step => step.if !== undefined || step['continue-on-error'];
  const steps = workflows['verify.yml']?.jobs?.test?.steps ?? [];
  const build = steps.findIndex(step => step.uses?.startsWith('docker/build-push-action@'));
  const smoke = steps.findIndex(step => step.run === CONTAINER_SMOKE_COMMAND);
  const keep = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.path === '${{ runner.temp }}/container-smoke/');
  const options = steps[build]?.with ?? {};
  if (build < 0 || optional(steps[build]) || options.context !== '.' || options.load !== true || options.push !== false
      || options.platforms !== 'linux/amd64' || options.tags !== CONTAINER_SMOKE_TAG) {
    fail('verify.yml/test', `build the image from this checkout (context ".", linux/amd64, load, no push) as ${CONTAINER_SMOKE_TAG}`);
  }
  if (smoke <= build || optional(steps[smoke]) || steps[smoke].shell !== 'bash') fail('verify.yml/test', 'run the container smoke on the image it built');
  if (keep <= smoke || steps[keep].if !== 'always()') fail('verify.yml/test', 'keep the container smoke report even after a failure');
  const candidate = workflows['publish-image.yml']?.jobs?.candidate?.steps ?? [];
  const tested = candidate.findIndex(step => step.id === 'smoke');
  const release = candidate.findIndex(step => step.run === RELEASE_CONTAINER_SMOKE_COMMAND);
  const push = candidate.findIndex(step => step.run === 'node scripts/image-release.mjs candidate');
  if (tested < 0 || release <= tested || push <= release || optional(candidate[release]) || candidate[release].shell !== 'bash'
      || candidate[release].env?.TESTED_IMAGE_ID !== '${{ steps.smoke.outputs.image_id }}') {
    fail('publish-image.yml/candidate', 'run the container smoke on the exact tested image before it is pushed');
  }
}

/**
 * The Codex a shipped FLUJO runs is checked where it is installed: the Windows
 * installer's fresh install runs one conversation, a restart and a cancel with
 * its own Codex, and release safety runs the same checks on both systems.
 */
export function assertPackagedCodexAcceptance(workflows) {
  const installer = workflows['installer.yml']?.jobs?.['installer-acceptance']?.steps ?? [];
  const acceptance = installer.findIndex(step => step.run?.includes(PACKAGED_ACCEPTANCE));
  const codex = installer.findIndex(step => step.run?.includes('node scripts/packaged-codex-acceptance.mjs --app-root $appRoot --report '));
  const upload = installer.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  if (codex < 0 || codex < acceptance || codex > upload || installer[codex].if !== undefined || installer[codex]['continue-on-error']
      || !installer[codex].run.includes("'FLUJO fresh install'")) {
    throw new Error('installer.yml/installer-acceptance must run the Codex checks on the fresh install after it is installed and before its evidence is kept.');
  }
  const safety = workflows['verify.yml']?.jobs?.['release-safety']?.steps ?? [];
  const unit = safety.find(step => step.run === 'node --test scripts/packaged-codex-acceptance.test.mjs');
  if (!unit || unit.if !== undefined || unit['continue-on-error']) {
    throw new Error('Release safety must run the shipped Codex checks on both operating systems.');
  }
}

/**
 * The release sweep only reports (docs/release-sweep.md): its jobs may file issues but never push code,
 * open pull requests or publish, and the job that can file issues never installs or runs FLUJO.
 */
export function assertReleaseSweepReportsOnly(workflow) {
  if (!workflow) return;
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    const permissions = job.permissions;
    if (!permissions || typeof permissions !== 'object'
        || Object.entries(permissions).some(([name, value]) => value === 'write' && name !== 'issues')) {
      throw new Error(`release-sweep.yml/${id} must declare its own permissions and may write nothing but issues: `
        + 'the sweep reports problems; it never pushes code, opens pull requests or publishes.');
    }
    if (permissions.issues === 'write' && (job.steps ?? []).some((step) => /\bnpm (?:ci|install)\b|\bnpx\b|release-sweep\/run\.mjs/.test(step.run ?? ''))) {
      throw new Error(`release-sweep.yml/${id} can file issues, so it must not install or run FLUJO. `
        + 'Run the sweep in a read-only job and pass its report on as an artifact.');
    }
  }
}

const SWEEP_MAX_JOB_MINUTES = 120;

/**
 * The release sweep runs after every published release with no switch to turn it on (#1449: no flags), needs
 * only the built-in GITHUB_TOKEN, files for real (the reporter's own cap and dedup keep that safe) and is bounded
 * in time (docs/release-sweep.md).
 */
export function assertReleaseSweepRunsByDefault(workflow) {
  if (!workflow) return;
  const fail = (message) => { throw new Error(`release-sweep.yml ${message}`); };
  const trigger = workflow.on?.workflow_run;
  if (!trigger?.workflows?.includes('Publish npm release') || !trigger.types?.includes('completed')) {
    fail('must start when a "Publish npm release" run completes, so every release is swept without anyone starting it.');
  }
  const text = JSON.stringify(workflow);
  if (/\bvars\./.test(text)) {
    fail('must not depend on repository variables: the sweep runs after every release by default, with no switch to set (#1449). '
      + 'Remove the vars. condition instead of asking for a setting.');
  }
  if (/\bsecrets\./.test(text)) {
    fail('must need nothing but the built-in token: use ${{ github.token }} with the issues: write permission, never a secret.');
  }
  const jobs = Object.entries(workflow.jobs ?? {});
  for (const [id, job] of jobs) {
    const minutes = job['timeout-minutes'];
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SWEEP_MAX_JOB_MINUTES) {
      fail(`/${id} must set timeout-minutes between 1 and ${SWEEP_MAX_JOB_MINUTES}, so a stuck sweep ends on its own.`);
    }
  }
  const filers = jobs.filter(([, job]) => job.permissions?.issues === 'write');
  const filing = filers.flatMap(([id, job]) => (job.steps ?? []).filter((step) => /release-sweep\/report-issues\.mjs/.test(step.run ?? ''))
    .map((step) => ({ id, job, step })));
  if (filers.length !== 1 || filing.length !== 1 || !/(?:^|\s)--file(?:\s|$)/.test(filing[0].step.run)
      || filing[0].step.if !== undefined || filing[0].job.if !== undefined || filing[0].step['continue-on-error']) {
    fail('must have exactly one job with issues: write, and it must run report-issues.mjs with --file on every run. '
      + 'Filing is safe by default (fingerprints, dedup, a cap per run); do not make it conditional.');
  }
  if (!/--total-timeout \d+/.test(text)) fail('must pass --total-timeout to run.mjs, so the sweep writes its report before the job time runs out.');
}

export function assertFullWorkflowContract(workflows, { mainIntegration = false } = {}) {
  assertInstallerProvenance(workflows['installer.yml']);
  assertReleaseSweepReportsOnly(workflows['release-sweep.yml']);
  assertReleaseSweepRunsByDefault(workflows['release-sweep.yml']);
  assertReleaseVerificationGates(workflows);
  assertPackagedAcceptance(workflows, { mainIntegration });
  assertPackagedCodexAcceptance(workflows);
  assertContainerSmoke(workflows);
  const releaseSteps = workflows['verify.yml']?.jobs?.['release-safety']?.steps ?? [];
  const installerDecisions = releaseSteps.find(step => step.name === 'Verify Windows installer decisions before publication');
  if (releaseSteps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth'] !== 0
      || installerDecisions?.if !== "runner.os == 'Windows'" || installerDecisions.shell !== 'powershell'
      || installerDecisions['continue-on-error']
      || installerDecisions.run !== 'Install-Module Pester -RequiredVersion 5.7.1 -Scope CurrentUser -Force -SkipPublisherCheck\nImport-Module Pester -RequiredVersion 5.7.1\nInvoke-Pester -Path tests/installer.Tests.ps1 -CI\n') {
    throw new Error('Release safety must enforce the full Windows installer decisions with pinned Pester and historical fixtures before publication.');
  }
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
  assertVerificationRunners(workflow);
  if (!workflow || !Object.hasOwn(workflow.on, 'workflow_dispatch') || (!mainIntegration && (Object.hasOwn(workflow.on, 'pull_request') || Object.hasOwn(workflow.on, 'push')))) {
    throw new Error('Broad qualification must be explicitly dispatched; it cannot run on every PR or push.');
  }
  for (const id of REQUIRED_JOB_IDS) {
    const job = workflow.jobs[id];
    if (!job || job.if !== undefined || job['continue-on-error']) throw new Error(`Required job ${id} cannot be conditional or optional.`);
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      if (step.if !== undefined && !isApplicationSelection('verify.yml', id, step.if)
          && !(id === 'release-safety' && step === installerDecisions)) throw new Error(`Required command in ${id} cannot be conditional.`);
      if (step['continue-on-error'] && !['npm run test:ci', 'npm run test:isolated'].includes(step.run)) {
        throw new Error(`Unapproved optional command in ${id}.`);
      }
    }
  }
  for (const id of ['production-build', 'release-safety']) {
    if (JSON.stringify(workflow.jobs[id].strategy?.matrix?.os) !== JSON.stringify(mainIntegration && id === 'production-build' ? ['ubuntu-latest'] : ['ubuntu-latest', 'windows-latest'])) {
      throw new Error(`${id} has an unexpected platform matrix.`);
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
  if (JSON.stringify(names) !== JSON.stringify(mainIntegration ? MAIN_CHECK_NAMES : REQUIRED_CHECK_NAMES)) throw new Error('Required check names drifted from the publication contract.');
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
  const preparation = mainTests[isolation].run;
  if (!preparation.includes("digest='sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'")
      || !preparation.includes('for registry in node:22.23.4-bookworm-slim public.ecr.aws/docker/library/node:22.23.4-bookworm-slim; do')
      || !preparation.includes('for attempt in 1 2; do')
      || !preparation.includes('pull "$registry@$digest"')
      || !preparation.includes('test -n "$image_ref"')
      || !preparation.includes('image inspect "$image_ref"')
      || !preparation.includes('[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]')) {
    throw new Error('Isolation pulls must retry bounded identical-digest mirrors and fail closed before publishing the inspected image identity.');
  }
  if (!mainIntegration) {
    assertAntigravityPlatformJob(workflow);
    assertSystemKeyStoreJobs(workflow);
    assertContributorGuideJob(workflow);
    assertFirstUseJourneyJob(workflow);
    assertScriptedPilotJob(workflow);
    assertClaudeCodePlatformJob(workflow);
    assertChatBurstLoadJob(workflow);
  }
  const gate = workflow.jobs.verification;
  if (gate?.name !== 'verification' || gate.if !== 'always()'
      || JSON.stringify(gate.needs) !== JSON.stringify(mainIntegration ? REQUIRED_JOB_IDS : [...REQUIRED_JOB_IDS, ...BROAD_ONLY_JOB_IDS])
      || gate['continue-on-error'] || !gate.steps.some((step) => step.run?.includes('assertFullDependencyResults') && step.if === undefined && !step['continue-on-error'])) {
    throw new Error('The required verification check must evaluate every prerequisite even after failures.');
  }
}

export function assertWorkflowContract(workflows) {
  assertRequiredCheckWorkflow(workflows['verify.yml']);
  for (const [name, workflow] of Object.entries(workflows)) {
    if (name !== 'verify.yml' && (Object.hasOwn(workflow.on ?? {}, 'pull_request') || Object.hasOwn(workflow.on ?? {}, 'pull_request_target'))) throw new Error('Only main integration verification may run on pull requests: ' + name);
  }
  const { 'verify-full.yml': full, ...other } = workflows;
  if (!full) throw new Error('Manual broad qualification is missing.');
  assertFullWorkflowContract(other, { mainIntegration: true });
  assertFullWorkflowContract({ ...other, 'verify.yml': full });
}
