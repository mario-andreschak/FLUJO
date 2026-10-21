#!/usr/bin/env node
// Kept separate from the application launcher: no runtime, dotenv or keyring imports.
try {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    process.stdout.write('Usage: flujo-controller <serve|status|disable|enable> /absolute/config.json [actor-id]\nRequires a dedicated unprivileged POSIX account, private local storage and a TLS proxy.\n');
    process.exit(0);
  }
  const { main } = await import('../packages/shared-controller/dist/cli.js');
  await main(process.argv.slice(2));
} catch {
  // Config/SQL/OIDC errors can contain secrets. Keep terminal output generic.
  process.stderr.write('FLUJO controller could not complete the command. Check its private configuration, POSIX storage permissions, issuer availability and controller ownership.\n');
  process.exitCode = 1;
}
