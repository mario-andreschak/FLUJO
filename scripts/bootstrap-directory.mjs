import path from 'node:path';

/** An embedding launcher must choose its dotenv directory before loading any file. */
export function bootstrapDirectory(defaultDirectory, env = process.env) {
  if (env.FLUJO_BOOTSTRAP_DIR === undefined) return defaultDirectory;
  const value = env.FLUJO_BOOTSTRAP_DIR;
  if (typeof value !== 'string' || !value || value !== value.trim()
    || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('FLUJO_BOOTSTRAP_DIR must be a nonempty absolute directory path.');
  }
  return path.normalize(value);
}

/** Keep runtime settings anchored to the selected directory after dotenv loads. */
export function loadBootstrapEnvironment(defaultDirectory, dev, loadEnvConfig, env = process.env) {
  const directory = bootstrapDirectory(defaultDirectory, env);
  env.FLUJO_RUNTIME_ENV_DIR = directory;
  const result = loadEnvConfig(directory, dev);
  env.FLUJO_RUNTIME_ENV_DIR = directory;
  return result;
}
