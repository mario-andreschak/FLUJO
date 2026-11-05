/**
 * Entry point for `flujo <subcommand>`: commands for running with nobody present.
 * Every failure ends in a short plain sentence and an exit code, never a stack.
 */
import { CliError } from './common.mjs';

const COMMANDS = {
  service: () => import('./service.mjs'),
  'unlock-secret': () => import('./unlock-secret.mjs'),
};

export async function runSubcommand(name, argv) {
  try {
    const { main } = await COMMANDS[name]();
    return await main(argv);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`[FLUJO] ${error.message}`);
      return error.exitCode;
    }
    console.error(`[FLUJO] The "${name}" command failed: ${error?.code ?? error?.message ?? 'unknown error'}`);
    return 1;
  }
}
