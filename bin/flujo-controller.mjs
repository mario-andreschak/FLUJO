#!/usr/bin/env node
// Kept separate from the application launcher: no runtime, dotenv or keyring imports.
try {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    process.stdout.write('Usage: flujo-controller setup /absolute/new-directory actor-id sha256:image-id\n       flujo-controller <provision|init|serve|status|disable|enable|password|reconcile> /absolute/config.json [actor-id]\nLocal accounts; no online identity provider. Requires an unprivileged account, private local storage and a local TLS proxy. Windows uses native ACLs on a local NTFS/ReFS drive and an unelevated account. Setup needs a local Docker CLI; the image must already be installed before provisioning. The password command prompts without echo. Managed runtimes use the local container engine; exit 2 means an execution transition is unconfirmed or unmanaged.\n');
    process.exit(0);
  }
  const { main } = await import('../packages/shared-controller/dist/cli.js');
  await main(process.argv.slice(2));
} catch {
  // Config/SQL errors can contain secrets. Keep terminal output generic.
  process.stderr.write('FLUJO controller could not complete the command. Check its local configuration, ledger schema, native storage permissions and controller ownership. Setup requires a new absolute directory, a lowercase account name, an installed Docker CLI and an exact sha256 image ID. Password entry requires an interactive terminal and matching passwords of at least 15 characters.\n');
  process.exitCode = 1;
}
