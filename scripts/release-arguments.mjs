export const releaseUsage = `Usage: node scripts/release.mjs [patch|minor|major|x.y.z] [--dry-run]
       node scripts/release.mjs --resume RUN_ID
       node scripts/release.mjs --help

Defaults to a minor release. --dry-run builds and checks without authentication.
--resume reruns failed jobs of an existing release, using its tested tarballs.
The npm_config_dry_run environment setting is also honored.`;

export function parseReleaseArguments(argv, env = {}) {
  const configuredDryRun = String(env.npm_config_dry_run ?? env.NPM_CONFIG_DRY_RUN ?? '').trim().toLowerCase();
  if (!['', 'false', '0', 'true', '1'].includes(configuredDryRun)) {
    throw new Error('Invalid npm_config_dry_run setting; use true, false, 1, or 0.');
  }

  let dryRun = configuredDryRun === 'true' || configuredDryRun === '1';
  let help = false;
  let bump;
  let resume = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--resume') {
      const id = argv[++index];
      if (resume !== null || !/^[1-9]\d*$/.test(id ?? '') || !Number.isSafeInteger(Number(id))) {
        throw new Error('--resume requires one positive GitHub Actions run ID.');
      }
      resume = id;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option '${argument}'. Use --dry-run or --help.`);
    } else {
      if (bump !== undefined) throw new Error('Specify only one release version or bump.');
      if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(argument)) {
        throw new Error(`Unknown bump '${argument}' - use patch, minor, major, or an exact x.y.z version.`);
      }
      bump = argument;
    }
  }
  if (resume !== null && (bump !== undefined || dryRun)) throw new Error('--resume cannot be combined with a version, bump, or --dry-run.');
  return { bump: bump ?? 'minor', dryRun, help, resume };
}
