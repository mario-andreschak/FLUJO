/** One canonical port for Next, instance discovery and browser opening in every exposure mode. */
export function launcherPort(value) {
  if (typeof value !== 'string' || value.length === 0 || /[^0-9]/.test(value)) {
    throw new Error('Invalid FLUJO port.');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid FLUJO port.');
  }
  return String(port);
}
