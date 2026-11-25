import fs from 'node:fs';

/**
 * Resolves symbolic links without blocking and returns the same path as
 * `fs.realpathSync`. `fs.promises.realpath` asks the operating system instead:
 * on Windows it expands short names (`C:\PROGRA~1` becomes `C:\Program Files`)
 * and changes letter case, so comparing its result with the path you started
 * from reports a link where there is none.
 */
export function realpath(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.realpath(target, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });
}
