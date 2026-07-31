#!/usr/bin/env node
// Cut a complete FLUJO release:
//   npm run release                 minor bump (3.33.0 -> 3.34.0)
//   npm run release patch           patch bump
//   npm run release major           major bump
//   npm run release 4.0.0           exact version
//   npm run release -- --dry-run    preflight only; changes nothing
//
// Publishing comes before pushing. The standalone MCP packages are
// published first at the exact flujo-ai version, then the application package.
// A failed npm publish cannot create a GitHub release or advance the official
// container image. Once npm succeeds, pushing main rebuilds the image and the
// version tag builds flujo-setup.exe and creates the GitHub release.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (command) =>
  execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const show = (command) => {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: 'inherit' });
};

const fail = (message) => {
  console.error(`\nRelease aborted: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((arg) => !arg.startsWith('--')) ?? 'minor';
const publicMcpPackages = [
  '@flujo-ai/mcp-flujo',
  '@flujo-ai/mcp-filesystem',
  '@flujo-ai/mcp-bash',
  '@flujo-ai/mcp-browser',
];

if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  fail(`unknown version '${bump}'; use patch, minor, major, or an exact x.y.z version.`);
}

// Preflight before npm version creates a commit and tag.
const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
  fail(`releases must be cut from main (currently on '${branch}').`);
}

if (run('git status --porcelain') !== '') {
  fail('the working tree is not clean; commit or stash all changes first.');
}

let npmUser;
try {
  npmUser = run('npm whoami');
} catch {
  fail('npm authentication failed; run "npm login", then confirm with "npm whoami".');
}
console.log(`Authenticated with npm as ${npmUser}.`);

let npmMaintainers;
try {
  npmMaintainers = JSON.parse(run('npm view flujo-ai maintainers --json'));
} catch {
  fail('could not verify the flujo-ai maintainers on npm.');
}
if (
  !Array.isArray(npmMaintainers) ||
  !npmMaintainers.some((maintainer) => maintainer.split(/\s/, 1)[0] === npmUser)
) {
  fail(`npm user '${npmUser}' is not a maintainer of flujo-ai.`);
}

console.log('Fetching origin/main and release tags ...');
try {
  run('git fetch origin main "+refs/tags/v*:refs/tags/v*"');
} catch {
  fail('could not fetch origin/main and release tags.');
}

if (run('git rev-parse main') !== run('git rev-parse origin/main')) {
  fail('main and origin/main differ; pull or push first.');
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`Current FLUJO version: ${current}`);
show('npm run build:mcp');
show('npm run validate:mcp-release');

if (dryRun) {
  console.log(
    `\nDry run passed. Would version '${bump}', publish the three MCP packages and flujo-ai, then push main and the new version tag.`,
  );
  process.exit(0);
}

show(`npm version ${bump} -m "Bump version to %s"`);

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
show('npm run validate:mcp-release');

try {
  for (const packageName of publicMcpPackages) {
    show(`npm publish --workspace ${packageName} --access public`);
  }
  show('npm publish');
} catch {
  fail(
    `npm publish failed. No Git refs were pushed, but earlier packages in the sequence may already be on npm. Inspect which packages reached npm, finish publishing all four at ${version}, then run "git push origin main ${tag}".`,
  );
}

try {
  show(`git push origin main ${tag}`);
} catch {
  fail(
    `npm package ${version} was published, but GitHub was not updated. Run "git push origin main ${tag}" after resolving the Git problem.`,
  );
}

console.log(`\nReleased FLUJO ${version}:`);
console.log(`  npm:    https://www.npmjs.com/package/flujo-ai/v/${version}`);
for (const packageName of publicMcpPackages) {
  console.log(`  npm:    https://www.npmjs.com/package/${packageName}/v/${version}`);
}
console.log(`  GitHub: https://github.com/mario-andreschak/FLUJO/releases/tag/${tag}`);
