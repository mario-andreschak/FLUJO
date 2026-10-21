#!/usr/bin/env node
// Kept separate from the application launcher: no runtime, dotenv or keyring imports.
try {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    process.stdout.write('Usage: flujo-controller <init|serve|status|disable|enable|password> /absolute/config.json [actor-id]\nLocal accounts; no online identity provider. Requires a dedicated unprivileged POSIX account, private local storage and a local TLS proxy. The password command prompts without echo.\n');
    process.exit(0);
  }
  const { main } = await import('../packages/shared-controller/dist/cli.js');
  await main(process.argv.slice(2));
} catch {
  // Config/SQL errors can contain secrets. Keep terminal output generic.
  process.stderr.write('FLUJO controller could not complete the command. Check its local configuration, ledger schema, POSIX storage permissions and controller ownership. Password entry requires an interactive terminal and matching passwords of at least 15 characters.\n');
  process.exitCode = 1;
}
