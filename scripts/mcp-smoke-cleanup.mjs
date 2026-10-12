/** Smoke diagnostics only: direct-child exit/stdio closure is not cohort absence. */
export async function withSmokeCleanup(operation, cleanup) {
  let result;
  let failure;
  let failed = false;
  try { result = await operation(); }
  catch (error) { failure = error; failed = true; }
  try { await cleanup(); }
  catch (error) {
    if (failed) {
      throw new AggregateError([failure, error], 'MCP artifact smoke and cleanup both failed.', { cause: failure });
    }
    throw error;
  }
  if (failed) throw failure;
  return result;
}

export async function cleanupSmokeSandbox({ stop, remove, sandbox }) {
  try { await stop(); }
  catch (error) {
    throw new Error(`MCP artifact smoke stop unresolved; sandbox retained at ${sandbox}.`, { cause: error });
  }
  try { await remove(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (error) {
    throw new Error(`MCP artifact smoke removal failed; remaining sandbox retained at ${sandbox}.`, { cause: error });
  }
}

export async function withTimeout(promise, limit, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), limit);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

// Attach at spawn, before exit/close can occur. Never reconstruct ownership from a PID.
export function observeSmokeChild(child) {
  const observation = { child, exited: false, closed: false, abandoned: false };
  observation.exit = new Promise((resolve) => child.once('exit', (code, signal) => {
    observation.exited = true;
    resolve({ code, signal });
  }));
  observation.close = new Promise((resolve) => child.once('close', (code, signal) => {
    observation.closed = true;
    resolve({ code, signal });
  }));
  return observation;
}

export async function stopSmokeChild(observation, description, {
  graceMs = 10_000, killMs = 5_000, closeMs = 5_000,
} = {}) {
  if (observation.abandoned) throw new Error(`${description} original stdio closure remains unresolved.`);
  if (observation.closed) return;
  const { child } = observation;
  const errors = [];
  const exited = () => observation.exited || child.exitCode !== null || child.signalCode !== null;
  try {
    if (child.pid && !exited()) {
      child.kill('SIGTERM');
      try { await withTimeout(observation.exit, graceMs, `${description} direct child to exit`); }
      catch (error) {
        errors.push(error);
        // Use only the original ChildProcess, and never signal it after observed exit.
        if (!exited()) child.kill('SIGKILL');
        await withTimeout(observation.exit, killMs, `${description} direct child after escalation`);
      }
    }
    await withTimeout(observation.close, closeMs, `${description} original stdio to close`);
  } catch (error) {
    errors.push(error);
    // Release this observer's handles so an unresolved inherited pipe cannot hang
    // the diagnostic runner. This is abandonment, never descendant-exit evidence.
    observation.abandoned = true;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  if (errors.length) throw new AggregateError(errors, `${description} cleanup failed.`);
}
