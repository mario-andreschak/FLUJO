/**
 * Environment keys that locate the signed-in host account and its tool config.
 * For the bundled Bash server each of them is exactly what the host has: one the
 * host leaves unset is removed, so a value saved on the server record can never
 * point a CLI at another home or config folder.
 */
const HOST_IDENTITY_KEYS = new Set([
  'path', 'pathext',
  'home', 'userprofile', 'homedrive', 'homepath',
  'appdata', 'localappdata', 'programdata',
  'xdg_config_home', 'xdg_cache_home', 'xdg_data_home',
  'xdg_state_home', 'xdg_runtime_dir',
  'tmp', 'temp', 'tmpdir',
  'shell', 'comspec', 'systemroot', 'windir', 'systemdrive',
  'programfiles', 'programfiles(x86)',
  'gh_config_dir',
]);

function setEnvCaseInsensitively(target: Record<string, string>, key: string, value: string | undefined): void {
  for (const existing of Object.keys(target)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete target[existing];
  }
  if (value !== undefined) target[key] = value;
}

/**
 * The environment of the bundled Bash server: the FLUJO process's own
 * environment, so installed CLIs behave as in a local terminal. Values saved on
 * the server record are kept only for keys the host does not define, and never
 * for a host identity key (HOST_IDENTITY_KEYS).
 */
export function hostTerminalEnvironment(
  configured: Record<string, string>,
  host: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const result = { ...configured };
  const hostEntries = Object.entries(host).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  for (const [key, value] of hostEntries) setEnvCaseInsensitively(result, key, value);
  for (const key of HOST_IDENTITY_KEYS) {
    if (!hostEntries.some(([name]) => name.toLowerCase() === key)) setEnvCaseInsensitively(result, key, undefined);
  }
  return result;
}
