#!/usr/bin/env node
// Kept separate from the application launcher: no runtime, dotenv or keyring imports.
try {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    process.stdout.write('Usage: flujo-controller setup /absolute/new-directory actor-id sha256:image-id\n       flujo-controller <provision|init|serve|status|disable|enable|password|reconcile> /absolute/config.json [actor-id]\n       flujo-controller <rotate|resume-rotation> /absolute/config.json actor-id\n       flujo-controller <disable-model|enable-model> /absolute/config.json actor-id grant-id\n       flujo-controller <tls-init|tls-renew> /absolute/config.json\n       flujo-controller <tls-trust|tls-untrust> /absolute/config.json [Linux-NSS-database]\nLocal accounts and HTTPS; no online identity, DNS or certificate service. Setup needs preinstalled Docker and OpenSSL 3. Windows requires an unelevated account and local NTFS/ReFS storage. TLS trust explicitly installs only the public installation CA into the current Windows user or Linux browser database; never share private keys. Linux trust needs NSS certutil. The password command prompts without echo. Stop the controller before rotation; resume-rotation recovers an interrupted operation without changing account enablement. Model grants authorize only configured loopback services and named models over a private process channel; host credentials stay on the host. The runtime image must already be installed; exit 2 means execution is unconfirmed or unmanaged.\n');
    process.exit(0);
  }
  const { main } = await import('../packages/shared-controller/dist/cli.js');
  await main(process.argv.slice(2));
} catch {
  // Config/SQL errors can contain secrets. Keep terminal output generic.
  process.stderr.write('FLUJO controller could not complete the command. Check local configuration, ledger schema, native storage permissions and controller ownership. Setup requires a new absolute directory, a lowercase account name, Docker, OpenSSL 3 and an exact sha256 image ID. Run tls-init before serving a new installation; tls-trust installs its public CA locally. Preserve existing TLS state for recovery; never bypass certificate validation. Password entry requires an interactive terminal and matching passwords of at least 15 characters. For a pending rotation, preserve its private candidate and ledger, stop the controller, then use resume-rotation with the same config and owner; status shows the journal phase.\n');
  process.exitCode = 1;
}
