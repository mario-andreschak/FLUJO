import { bundledCodexExecutable } from './codexRestrictedProfile';
import { readOrdinaryCodexVersion } from './codexRuntimeUpdate';

/** Quote a literal path for the host terminal; never execute a generated command. */
export function codexLoginCommand(executable: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `& '${executable.replaceAll("'", "''")}' login`
    : `'${executable.replaceAll("'", "'\\''")}' login`;
}

/** Probe the executable FLUJO ships, without signing in or starting inference. */
export async function inspectBundledCodexSetup(): Promise<{ bundled: boolean; loginCommand?: string }> {
  try {
    const executable = bundledCodexExecutable();
    await readOrdinaryCodexVersion(executable);
    return { bundled: true, loginCommand: codexLoginCommand(executable) };
  } catch {
    return { bundled: false };
  }
}
